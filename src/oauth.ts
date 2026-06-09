/**
 * Stateless OAuth 2.1 helpers for the ABRP MCP server.
 *
 * The deployment needs no database: every artifact the OAuth flow produces
 * (authorization code, access token, refresh token, dynamically-registered
 * client id) is an AES-256-GCM sealed JSON blob. Authenticated encryption means
 * the server can verify a token it issued without storing anything — tampering
 * fails the GCM auth tag, and the embedded `exp` bounds its lifetime.
 *
 * The user's ABRP credentials (API key + optional session / telemetry tokens)
 * are sealed *inside* the access/refresh tokens, so the MCP endpoint recovers
 * them per-request without a session store.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const IS_PROD = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";

if (!process.env.OAUTH_SECRET) {
  // Fail closed in production: every token is sealed with this key, so a known
  // fallback would let anyone forge tokens and unseal users' ABRP credentials.
  if (IS_PROD) throw new Error("OAUTH_SECRET must be set in production.");
  console.warn(
    "[abrp-mcp] OAUTH_SECRET is not set — using an insecure dev fallback. Set OAUTH_SECRET in production.",
  );
}

const SECRET = process.env.OAUTH_SECRET ?? "abrp-mcp-INSECURE-dev-secret-set-OAUTH_SECRET";
const ENC_KEY = scryptSync(SECRET, "abrp-mcp/oauth/v1", 32);

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Tokens are stateless and cannot be revoked before expiry, so keep the access
// token short-lived (clients refresh transparently) and the refresh token
// bounded. A leaked access token exposes the sealed ABRP key only until it expires.
const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLIENT_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

type Purpose = "code" | "access" | "refresh" | "client";

/** The bundle of ABRP credentials a user authorises with. */
export interface AbrpCredentials {
  /** Planning API key (X-API-KEY). Required. */
  apiKey: string;
  /** ABRP user session (X-ABRP-SESSION). Optional. */
  session?: string;
  /** Telemetry token (X-TLM-TOKEN, v2). Optional. */
  tlmToken?: string;
  /** ABRP user token for the v1 /tlm/send endpoint. Optional. */
  userToken?: string;
}

interface Sealed {
  p: Purpose;
  exp: number;
  /** ABRP API key (code/access/refresh). */
  k?: string;
  /** ABRP user session (code/access/refresh). */
  s?: string;
  /** Telemetry token (code/access/refresh). */
  t?: string;
  /** v1 user token (code/access/refresh). */
  u?: string;
  /** PKCE code_challenge (code). */
  cc?: string;
  /** redirect_uri the code was issued for (code). */
  ru?: string;
  /** client_id the code was issued for (code). */
  ci?: string;
  /** allowed redirect_uris (client). */
  rl?: string[];
}

function seal(payload: Sealed): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString("base64url");
}

function open(token: string, purpose: Purpose): Sealed | null {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    const payload = JSON.parse(out.toString("utf8")) as Sealed;
    if (payload.p !== purpose) return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const credFields = (c: AbrpCredentials) => ({
  k: c.apiKey,
  s: c.session || undefined,
  t: c.tlmToken || undefined,
  u: c.userToken || undefined,
});

const readCreds = (p: Sealed): AbrpCredentials | null =>
  p.k ? { apiKey: p.k, session: p.s, tlmToken: p.t, userToken: p.u } : null;

// --- Client registration (RFC 7591) ---------------------------------------

export function mintClientId(redirectUris: string[]): string {
  return seal({ p: "client", rl: redirectUris, exp: Date.now() + CLIENT_TTL_MS });
}

export function readClient(clientId: string): { redirectUris: string[] } | null {
  const payload = open(clientId, "client");
  if (!payload?.rl) return null;
  return { redirectUris: payload.rl };
}

// --- Authorization code ----------------------------------------------------

export function mintAuthCode(args: {
  credentials: AbrpCredentials;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
}): string {
  return seal({
    p: "code",
    ...credFields(args.credentials),
    cc: args.codeChallenge,
    ru: args.redirectUri,
    ci: args.clientId,
    exp: Date.now() + CODE_TTL_MS,
  });
}

export function readAuthCode(code: string): {
  credentials: AbrpCredentials;
  codeChallenge: string;
  redirectUri: string;
  clientId: string;
} | null {
  const p = open(code, "code");
  if (!p) return null;
  const credentials = readCreds(p);
  if (!credentials || !p.cc || !p.ru || !p.ci) return null;
  return { credentials, codeChallenge: p.cc, redirectUri: p.ru, clientId: p.ci };
}

// --- Access & refresh tokens ----------------------------------------------

export function mintAccessToken(credentials: AbrpCredentials): string {
  return seal({ p: "access", ...credFields(credentials), exp: Date.now() + ACCESS_TTL_MS });
}

export function mintRefreshToken(credentials: AbrpCredentials): string {
  return seal({ p: "refresh", ...credFields(credentials), exp: Date.now() + REFRESH_TTL_MS });
}

export function readAccessToken(token: string): AbrpCredentials | null {
  const p = open(token, "access");
  return p ? readCreds(p) : null;
}

export function readRefreshToken(token: string): AbrpCredentials | null {
  const p = open(token, "refresh");
  return p ? readCreds(p) : null;
}

export const ACCESS_TTL_SECONDS = Math.floor(ACCESS_TTL_MS / 1000);

// --- PKCE (RFC 7636, S256 only) -------------------------------------------

export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
