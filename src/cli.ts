import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { validateRuleSet } from "./rules/validate.js";
import { runSearch } from "./search/compiler.js";
import { verifyReplay } from "./trace/replay.js";
import { runSimulation } from "./simulation/engine.js";

const SUPPORTED_EVENTS = ["collision", "damage", "entity-created", "heat-changed", "gravity-changed", "entity-destroyed", "tick"] as const;
const SUPPORTED_EFFECTS = ["damage", "create-entity", "change-heat", "change-gravity", "destroy-entity"] as const;

class UsageError extends Error {}

function usage(): string {
  return [
    "Rule Riot backend CLI",
    "",
    "Commands:",
    "  list-rules                 Print the supported event/effect vocabulary",
    "  validate [--input FILE]    Validate a JSON rule array or {rules: [...]} object",
    "  simulate [--input FILE]    Run one SimulationRequest",
    "  search [--input FILE]      Run one bounded SearchRequest",
    "  inspect [--input FILE]     Summarize a SearchResult discovery or SimulationTrace",
    "  verify [--input FILE]      Replay-verify a trace or found SearchResult",
    "",
    "Without --input, commands read JSON from stdin. Structured output is JSON on stdout.",
  ].join("\n");
}

async function readInput(args: string[]): Promise<unknown> {
  const inputIndex = args.indexOf("--input");
  const fileIndex = args.indexOf("--file");
  const index = inputIndex >= 0 ? inputIndex : fileIndex;
  let text: string;
  if (index >= 0) {
    const file = args[index + 1];
    if (file === undefined || file.startsWith("--")) throw new UsageError("--input requires a file path");
    text = await readFile(file, "utf8");
  } else {
    text = await new Promise<string>((resolve, reject) => {
      let result = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string | Buffer) => { result += chunk.toString(); });
      stdin.on("end", () => resolve(result));
      stdin.on("error", reject);
    });
  }
  if (text.trim().length === 0) throw new UsageError("JSON input is empty");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function write(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapTrace(input: unknown): unknown {
  if (isRecord(input) && isRecord(input.discovery) && input.discovery.simulation !== undefined) return input.discovery.simulation;
  return input;
}

function inspect(input: unknown): unknown {
  const trace = unwrapTrace(input);
  if (!isRecord(trace) || !Array.isArray(trace.entries) || !isRecord(trace.finalState) || !isRecord(trace.termination)) throw new UsageError("Expected a SimulationTrace or a found SearchResult");
  const entries = trace.entries.filter(isRecord).map((entry) => {
    const event = isRecord(entry.event) ? entry.event : {};
    return {
      id: event.id,
      type: event.type,
      step: event.step,
      entityId: event.entityId,
      targetEntityId: event.targetEntityId,
      parentEventId: event.parentEventId,
      sourceRuleId: event.sourceRuleId,
      matchedRuleIds: entry.matchedRuleIds,
      scheduledEventIds: Array.isArray(entry.scheduledEvents) ? entry.scheduledEvents.filter(isRecord).map((scheduled) => scheduled.id) : [],
    };
  });
  return { engineVersion: trace.engineVersion, seed: trace.seed, termination: trace.termination, metrics: trace.metrics, finalState: trace.finalState, entries };
}

async function execute(command: string, args: string[]): Promise<number> {
  if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    write({ usage: usage() });
    return command === undefined ? 1 : 0;
  }
  if (command === "list-rules") {
    write({ events: SUPPORTED_EVENTS, effects: SUPPORTED_EFFECTS, rule: { id: "lowercase-kebab-case", trigger: "{eventType, optional conditions}", effects: "one to eight allowlisted data effects" } });
    return 0;
  }

  const input = await readInput(args);
  if (command === "validate") {
    const rules = Array.isArray(input) ? input : isRecord(input) ? input.rules : undefined;
    const result = validateRuleSet(rules);
    write({ valid: result.ok, errors: result.errors });
    return result.ok ? 0 : 1;
  }
  if (command === "simulate") {
    const result = runSimulation(input);
    write(result);
    if (result.status === "invalid-input") return 1;
    return result.status === "completed" ? 0 : 2;
  }
  if (command === "search") {
    const result = runSearch(input);
    write(result);
    if (result.status === "invalid-input") return 1;
    return result.status === "found" ? 0 : 2;
  }
  if (command === "inspect") {
    write(inspect(input));
    return 0;
  }
  if (command === "verify") {
    const result = verifyReplay(unwrapTrace(input));
    write(result);
    if (result.status === "verified") return 0;
    return result.status === "unsupported-version" || result.status === "mismatch" ? 2 : 1;
  }
  throw new UsageError(`Unknown command: ${command}\n\n${usage()}`);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  try {
    return await execute(command!, args);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    stderr.write(`Internal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    return 3;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  main().then((code) => { process.exitCode = code; });
}
