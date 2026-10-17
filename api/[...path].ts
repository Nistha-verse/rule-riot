import type { IncomingMessage, ServerResponse } from "node:http";
import { handleVercelRequest } from "../src/server/vercel-handler.js";

/** Vercel's Node runtime hands the request to the same Fastify application used locally. */
export default function handler(request: IncomingMessage, response: ServerResponse): void {
  handleVercelRequest(request, response);
}
