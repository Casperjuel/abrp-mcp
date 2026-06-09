import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { serve } from "@hono/node-server";

// Load .env before importing the app, so modules that read process.env at
// import time (e.g. the OAuth secret) see the values. Node 20.12+ / 23.
if (existsSync(".env")) process.loadEnvFile(".env");

const { createApp } = await import("./server.js");

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

// Serve HTTPS when a local cert exists (generate with mkcert — see README).
// Claude Desktop's connector UI requires https, and a mkcert-issued cert is
// trusted locally, so https://localhost works with no warnings and no tunnel.
const certPath = process.env.TLS_CERT ?? "certs/localhost.pem";
const keyPath = process.env.TLS_KEY ?? "certs/localhost-key.pem";
const useHttps = existsSync(certPath) && existsSync(keyPath);

serve(
  {
    fetch: app.fetch,
    port,
    ...(useHttps
      ? {
          createServer: createHttpsServer,
          serverOptions: { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        }
      : {}),
  },
  (info) => {
    const scheme = useHttps ? "https" : "http";
    console.log(`abrp-mcp listening on ${scheme}://localhost:${info.port}`);
    console.log(`MCP endpoint: ${scheme}://localhost:${info.port}/mcp`);
  },
);
