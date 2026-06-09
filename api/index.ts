import { getRequestListener } from "@hono/node-server";
import { createApp } from "../src/server.js";

export const config = { runtime: "nodejs" };

const app = createApp();

// Vercel's Node.js runtime invokes the default export with Node's
// (IncomingMessage, ServerResponse). getRequestListener bridges that to Hono's
// Web-standard fetch handler — the same adapter @hono/node-server's `serve`
// uses internally. (hono/vercel's `handle` targets the Edge runtime and hangs
// here; @hono/node-server dropped its `/vercel` subpath in v2.)
export default getRequestListener(app.fetch);
