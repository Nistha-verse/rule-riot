import { createApiApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const app = createApiApp();
let closing = false;

async function close(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`Failed to close API after ${signal}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => { void close("SIGINT"); });
process.once("SIGTERM", () => { void close("SIGTERM"); });

try {
  await app.listen({ port, host });
  process.stdout.write(`Rule Riot API listening on http://${host}:${port}/api/v1/health\n`);
} catch (error) {
  process.stderr.write(`Unable to start Rule Riot API: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
