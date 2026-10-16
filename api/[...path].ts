import type { IncomingMessage, ServerResponse } from "node:http";
import { createApiApp } from "../src/server/app.js";

const app = createApiApp();
await app.ready();

/** Vercel's Node runtime hands the request to the same Fastify application used locally. */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  app.server.emit("request", request, response);
}
