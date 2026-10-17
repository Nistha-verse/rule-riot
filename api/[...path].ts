import type { IncomingMessage, ServerResponse } from "node:http";
import { createApiApp } from "../src/server/app.js";

const app = createApiApp();
await app.ready();

/** Vercel's Node runtime hands the request to the same Fastify application used locally. */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  // Vercel's catch-all adapter can pass the path with the `/api` segment
  // already removed. Fastify's local routes intentionally include the full
  // versioned prefix, so normalize both invocation shapes here.
  if (request.url !== undefined && !request.url.startsWith("/api/")) {
    request.url = `/api${request.url.startsWith("/") ? "" : "/"}${request.url}`;
  }
  app.server.emit("request", request, response);
}
