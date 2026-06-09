# Security Policy

## Reporting a vulnerability

This project handles credentials (ABRP API keys and OAuth tokens), so security reports are taken
seriously. **Please report vulnerabilities privately** rather than opening a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/Casperjuel/abrp-mcp/security/advisories/new), or
- Email **info@casperjuel.dk** with details and steps to reproduce.

You'll get an acknowledgement as soon as possible. Please give a reasonable window to fix before
any public disclosure.

## Good to know

- **Bring your own key.** A deployment holds no API key unless `ABRP_API_KEY` is set. In the
  multi-tenant (OAuth) setup, each user's ABRP credentials are sealed (AES-256-GCM) inside their
  access token — nothing is stored server-side.
- **Set `OAUTH_SECRET` in production.** The server refuses to start in production without it (every
  token is sealed with a key derived from it). Use a long random value (`openssl rand -base64 48`).
- **Never commit keys.** `.env` and `certs/` are gitignored. The ABRP web app's shared key is not a
  personal secret, but please don't commit or redistribute it.
- Tokens are stateless and can't be revoked before expiry; access tokens are short-lived (1 h) and
  refresh tokens are bounded (30 d) to limit the blast radius of a leak.

## Scope

This is an unofficial hobby project and is not affiliated with Iternio. Vulnerabilities in the
upstream ABRP / Iternio API should be reported to Iternio directly (`contact@iternio.com`).
