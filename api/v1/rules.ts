import type { IncomingMessage, ServerResponse } from "node:http";
import { handleVercelRequest } from "../../src/server/vercel-handler.js";
export default function handler(request: IncomingMessage, response: ServerResponse): void { handleVercelRequest(request, response); }
