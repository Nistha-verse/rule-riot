import { Worker } from "node:worker_threads";
import { API_LIMITS } from "./contracts.js";
import type { SearchResult } from "../search/types.js";

export class SearchExecutionTimeout extends Error {
  constructor() {
    super(`Search worker exceeded the ${API_LIMITS.searchTimeoutMs}ms HTTP execution limit`);
    this.name = "SearchExecutionTimeout";
  }
}

export function runSearchInWorker(input: unknown): Promise<SearchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./search-worker.js", import.meta.url));
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new SearchExecutionTimeout());
      });
    }, API_LIMITS.searchTimeoutMs);
    worker.once("message", (message: { ok: boolean; result?: SearchResult; message?: string }) => {
      finish(() => {
        void worker.terminate();
        if (message.ok && message.result !== undefined) resolve(message.result);
        else reject(new Error(message.message ?? "Search worker failed"));
      });
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error(`Search worker exited with code ${code}`)));
    });
    worker.postMessage(input);
  });
}
