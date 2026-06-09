# Contributing to abrp-mcp

Thanks for taking a look! This is an unofficial, open-source hobby project that wraps the
[A Better Route Planner](https://abetterrouteplanner.com) / Iternio API as an MCP server. Bug
reports, ideas and pull requests are all welcome.

> Not affiliated with Iternio. Please be a good citizen of their API — don't hammer the `/plan`
> endpoint (it's billed) and don't redistribute the web app's shared key.

## Getting set up

Requirements: Node ≥ 20 and [pnpm](https://pnpm.io) 10.

```bash
git clone https://github.com/Casperjuel/abrp-mcp
cd abrp-mcp
pnpm install
cp .env.example .env        # set OAUTH_SECRET; add ABRP_API_KEY for a keyless local run
pnpm dev                    # http://localhost:3000  (or https with mkcert certs — see README)
pnpm typecheck              # tsc --noEmit — please keep this green
pnpm test                   # vitest
pnpm lint                   # biome check  (pnpm format to auto-fix)
```

Quick smoke test:

```bash
curl -s localhost:3000/health
curl -s -X POST localhost:3000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Project layout

| File | Responsibility |
| --- | --- |
| `src/abrp.ts` | Typed HTTP client for the ABRP v2 + v1 APIs |
| `src/tools.ts` | MCP tool definitions (Zod input schemas) |
| `src/server.ts` | Hono app: routes, OAuth, the `/mcp` transport |
| `src/oauth.ts` | Stateless OAuth 2.1 (AES-256-GCM sealed tokens) |
| `src/login-page.ts` | The credential entry page |
| `api/index.ts` | Vercel entrypoint (Node runtime) |

## Adding a tool

1. Add a method to `AbrpClient` in `src/abrp.ts` for the endpoint.
2. Register the tool in `src/tools.ts` with a clear `description` and a Zod `inputSchema`.
3. If the response can be large, slim it (see `slimPlan` for why — Claude caps tool results at 1 MB).
4. `pnpm typecheck && pnpm test`, then try it via an MCP client or the `curl` above.

## Pull requests

- Branch off `main`, keep PRs focused, and describe what and why.
- Keep `pnpm typecheck`, `pnpm test` and `pnpm lint` green — CI runs all three on PRs. Code is
  formatted/linted with [Biome](https://biomejs.dev); run `pnpm format` to auto-fix.
- Match the surrounding style — small, well-commented, dependency-light.
- For anything large (new auth model, big refactor), open an issue first so we can align.

## Reporting bugs / ideas

Open a [GitHub issue](https://github.com/Casperjuel/abrp-mcp/issues) with steps to reproduce (or a
description of the idea). For security issues, see [SECURITY.md](./SECURITY.md) — please don't open
a public issue for those.
