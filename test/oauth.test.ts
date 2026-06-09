import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AbrpCredentials,
  mintAccessToken,
  mintAuthCode,
  mintClientId,
  readAccessToken,
  readAuthCode,
  readClient,
  readRefreshToken,
  verifyPkce,
} from "../src/oauth.js";

const creds: AbrpCredentials = {
  apiKey: "key-123",
  session: "sess-abc",
  tlmToken: "tlm-xyz",
  userToken: "user-999",
};

describe("oauth sealing", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips an access token", () => {
    expect(readAccessToken(mintAccessToken(creds))).toEqual(creds);
  });

  it("rejects a token used for the wrong purpose", () => {
    expect(readRefreshToken(mintAccessToken(creds))).toBeNull();
  });

  it("rejects an expired access token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = mintAccessToken(creds);
    vi.setSystemTime(new Date("2026-01-01T02:00:00Z")); // access TTL is 1h
    expect(readAccessToken(token)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = mintAccessToken(creds);
    const tampered = token.slice(0, -3) + (token.endsWith("A") ? "B" : "A");
    expect(readAccessToken(tampered)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(readAccessToken("not-a-token")).toBeNull();
  });
});

describe("auth code + pkce", () => {
  it("round-trips an auth code and verifies PKCE", () => {
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const code = mintAuthCode({
      credentials: creds,
      codeChallenge: challenge,
      redirectUri: "http://localhost:9999/cb",
      clientId: "cid-1",
    });
    const read = readAuthCode(code);
    expect(read?.credentials).toEqual(creds);
    expect(read?.redirectUri).toBe("http://localhost:9999/cb");
    expect(verifyPkce(verifier, read!.codeChallenge)).toBe(true);
    expect(verifyPkce("wrong-verifier", read!.codeChallenge)).toBe(false);
  });
});

describe("client registration", () => {
  it("round-trips registered redirect URIs", () => {
    const cid = mintClientId(["http://localhost/cb"]);
    expect(readClient(cid)?.redirectUris).toEqual(["http://localhost/cb"]);
  });
  it("rejects an invalid client id", () => {
    expect(readClient("garbage")).toBeNull();
  });
});
