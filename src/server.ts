import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { AbrpClient } from "./abrp.js";
import { renderLoginPage } from "./login-page.js";
import {
  type AbrpCredentials,
  ACCESS_TTL_SECONDS,
  mintAccessToken,
  mintAuthCode,
  mintClientId,
  mintRefreshToken,
  readAccessToken,
  readAuthCode,
  readClient,
  readRefreshToken,
  verifyPkce,
} from "./oauth.js";
import { registerAbrpTools } from "./tools.js";

/** Forbid caching of OAuth credential/token responses (RFC 6749 §5.1). */
async function noStore(c: Context, next: () => Promise<void>) {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
}

/** Public origin of this deployment, derived from the incoming request. */
function origin(c: Context): string {
  const host = c.req.header("host") ?? "localhost";
  const proto =
    c.req.header("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Env-configured fallback credentials, if any. */
function envCredentials(): AbrpCredentials | undefined {
  const apiKey = process.env.ABRP_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    session: process.env.ABRP_SESSION || undefined,
    userToken: process.env.ABRP_USER_TOKEN || undefined,
    tlmToken: process.env.ABRP_TLM_TOKEN || undefined,
  };
}

/**
 * Resolve ABRP credentials for a request.
 *
 * Primary path: a Bearer token issued by our OAuth flow (credentials sealed
 * inside). Dev escape hatches: explicit X-ABRP-* headers, or the ABRP_* env
 * vars. A Bearer token that is present but invalid is a hard failure — we do
 * not silently fall through to env credentials. Individual header values, when
 * present, override the corresponding sealed/env value.
 */
function resolveCredentials(c: Context): { credentials?: AbrpCredentials; badToken?: boolean } {
  let base: AbrpCredentials | undefined;

  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const creds = readAccessToken(auth.slice(7).trim());
    if (!creds) return { badToken: true };
    base = creds;
  } else {
    const headerKey = c.req.header("x-abrp-api-key") ?? c.req.header("x-api-key");
    if (headerKey) base = { apiKey: headerKey };
    else base = envCredentials();
  }

  if (!base) return {};

  // Per-request header overrides for secondary credentials.
  const session = c.req.header("x-abrp-session");
  const tlmToken = c.req.header("x-tlm-token");
  const userToken = c.req.header("x-abrp-token");
  return {
    credentials: {
      apiKey: base.apiKey,
      session: session ?? base.session,
      tlmToken: tlmToken ?? base.tlmToken,
      userToken: userToken ?? base.userToken,
    },
  };
}

function buildMcpServer(getClient: () => AbrpClient): McpServer {
  const server = new McpServer({ name: "abrp-mcp", version: "0.1.0" });
  registerAbrpTools(server, getClient);
  return server;
}

export function createApp(): Hono {
  const app = new Hono();

  // OAuth-sensitive routes carry credentials, codes and tokens — never cache.
  app.use("/authorize", noStore);
  app.use("/token", noStore);
  app.use("/register", noStore);

  app.get("/", (c) =>
    c.json({
      name: "abrp-mcp",
      description:
        "Unofficial MCP server for the A Better Route Planner (ABRP) / Iternio EV routing API. Not affiliated with Iternio.",
      mcp_endpoint: "/mcp",
      authorization: `${origin(c)}/.well-known/oauth-authorization-server`,
      docs: "https://api.iternio.com/swagger-ui/",
    }),
  );

  app.get("/health", (c) => c.json({ status: "ok" }));

  // --- OAuth: discovery metadata ------------------------------------------
  // Protected Resource Metadata (RFC 9728).
  const protectedResourceMetadata = (c: Context) =>
    c.json({
      resource: `${origin(c)}/mcp`,
      authorization_servers: [origin(c)],
      bearer_methods_supported: ["header"],
    });
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);

  // Authorization Server Metadata (RFC 8414).
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const o = origin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["abrp"],
    });
  });

  // --- OAuth: dynamic client registration (RFC 7591) ----------------------
  app.post("/register", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_client_metadata" }, 400);
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string")
      : [];
    if (redirectUris.length === 0) {
      return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" }, 400);
    }
    const clientId = mintClientId(redirectUris);
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      },
      201,
    );
  });

  // --- OAuth: authorization endpoint --------------------------------------
  // GET renders the login page; POST validates the key and redirects with a code.
  app.get("/authorize", (c) => {
    const q = c.req.query();
    const error = validateAuthorizeParams(q);
    if (error) return c.text(error, 400);
    return c.html(renderLoginPage({ fields: authFields(q) }));
  });

  app.post("/authorize", async (c) => {
    // Parse the urlencoded form via text() rather than parseBody()/formData(),
    // which deadlocks under the Vercel Node adapter. The text/json body path works.
    const form = new URLSearchParams(await c.req.text());
    const f = (k: string) => form.get(k) ?? "";
    const fields = authFields({
      client_id: f("client_id"),
      redirect_uri: f("redirect_uri"),
      state: f("state"),
      code_challenge: f("code_challenge"),
      code_challenge_method: f("code_challenge_method"),
      scope: f("scope"),
      response_type: f("response_type") || "code",
    });
    const paramError = validateAuthorizeParams(fields as unknown as Record<string, string | undefined>);
    if (paramError) return c.text(paramError, 400);

    const apiKey = f("api_key").trim();
    const values = {
      api_key: apiKey,
      session: f("session").trim(),
      tlm_token: f("tlm_token").trim(),
      user_token: f("user_token").trim(),
    };
    const reshow = (error: string) => c.html(renderLoginPage({ fields, values, error }), 400);

    if (!apiKey) return reshow("Please enter your ABRP Planning API key.");

    const credentials: AbrpCredentials = {
      apiKey,
      session: values.session || undefined,
      tlmToken: values.tlm_token || undefined,
      userToken: values.user_token || undefined,
    };

    // Validate the key against a free endpoint before issuing a code.
    try {
      await new AbrpClient(credentials).checkAccess();
    } catch {
      return reshow("That API key was rejected by ABRP. Check the key and try again.");
    }

    const code = mintAuthCode({
      credentials,
      codeChallenge: fields.code_challenge,
      redirectUri: fields.redirect_uri,
      clientId: fields.client_id,
    });

    const redirect = new URL(fields.redirect_uri);
    redirect.searchParams.set("code", code);
    if (fields.state) redirect.searchParams.set("state", fields.state);
    return c.redirect(redirect.toString(), 302);
  });

  // --- OAuth: token endpoint ----------------------------------------------
  app.post("/token", async (c) => {
    // Parse the urlencoded form via text() rather than parseBody()/formData(),
    // which deadlocks under the Vercel Node adapter. The text/json body path works.
    const form = new URLSearchParams(await c.req.text());
    const f = (k: string) => form.get(k) ?? "";
    const grantType = f("grant_type");

    if (grantType === "authorization_code") {
      const code = readAuthCode(f("code"));
      if (!code) return tokenError(c, "invalid_grant", "Authorization code is invalid or expired.");
      if (code.redirectUri !== f("redirect_uri"))
        return tokenError(c, "invalid_grant", "redirect_uri mismatch.");
      if (code.clientId !== f("client_id")) return tokenError(c, "invalid_grant", "client_id mismatch.");
      if (!verifyPkce(f("code_verifier"), code.codeChallenge))
        return tokenError(c, "invalid_grant", "PKCE verification failed.");

      return c.json({
        access_token: mintAccessToken(code.credentials),
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: mintRefreshToken(code.credentials),
        scope: "abrp",
      });
    }

    if (grantType === "refresh_token") {
      const creds = readRefreshToken(f("refresh_token"));
      if (!creds) return tokenError(c, "invalid_grant", "Refresh token is invalid or expired.");
      return c.json({
        access_token: mintAccessToken(creds),
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: mintRefreshToken(creds),
        scope: "abrp",
      });
    }

    return tokenError(c, "unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
  });

  // --- MCP endpoint --------------------------------------------------------
  app.all("/mcp", async (c) => {
    const { credentials, badToken } = resolveCredentials(c);
    if (!credentials) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin(c)}/.well-known/oauth-protected-resource"`,
      );
      return c.json(
        {
          error: badToken ? "invalid_token" : "unauthorized",
          error_description: badToken
            ? "The access token is invalid or expired."
            : "Authentication required. Authorize via OAuth or send an X-API-KEY header.",
        },
        401,
      );
    }

    const client = new AbrpClient(credentials);
    const server = buildMcpServer(() => client);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const res = await transport.handleRequest(c);
    return res ?? c.body(null, 204);
  });

  return app;
}

interface AuthFields {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  response_type: string;
}

function authFields(q: Record<string, string | undefined>): AuthFields {
  return {
    client_id: q.client_id ?? "",
    redirect_uri: q.redirect_uri ?? "",
    state: q.state ?? "",
    code_challenge: q.code_challenge ?? "",
    code_challenge_method: q.code_challenge_method ?? "",
    scope: q.scope ?? "",
    response_type: q.response_type ?? "code",
  };
}

/** Validate the shared subset of authorize params. Returns an error string or undefined. */
function validateAuthorizeParams(p: Record<string, string | undefined>): string | undefined {
  if ((p.response_type ?? "code") !== "code") return "Only response_type=code is supported.";
  if (!p.client_id) return "Missing client_id.";
  if (!p.redirect_uri) return "Missing redirect_uri.";
  if (!p.code_challenge) return "Missing code_challenge (PKCE is required).";
  if ((p.code_challenge_method ?? "S256") !== "S256") return "Only code_challenge_method=S256 is supported.";

  const client = readClient(p.client_id);
  if (!client) return "Unknown or expired client_id.";
  if (!client.redirectUris.includes(p.redirect_uri)) return "redirect_uri is not registered for this client.";
  return undefined;
}

function tokenError(c: Context, error: string, description: string) {
  return c.json({ error, error_description: description }, 400);
}
