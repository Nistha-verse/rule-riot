import { parentPort } from "node:worker_threads";
import { runSearch } from "../search/compiler.js";

if (parentPort === null) throw new Error("Rule Riot search worker requires a parent port");

parentPort.on("message", (input: unknown) => {
  try {
    parentPort!.postMessage({ ok: true, result: runSearch(input) });
  } catch (error) {
    parentPort!.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
});
