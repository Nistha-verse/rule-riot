import type { IncomingMessage, ServerResponse } from "node:http";
import { createApiApp } from "./app.js";

const app = createApiApp();
await app.ready();

export function handleVercelRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.url !== undefined && !request.url.startsWith("/api/")) {
    request.url = `/api${request.url.startsWith("/") ? "" : "/"}${request.url}`;
  }
  app.server.emit("request", request, response);
}
