import { canonicalStringify } from "../domain/canonical.js";
import type { SimulationTrace, ValidationIssue } from "../domain/types.js";
import { runSimulation } from "../simulation/engine.js";
import { validateSimulationRequest } from "../rules/validate.js";
import { ENGINE_VERSION } from "../version.js";

export type ReplayResult =
  | { status: "verified"; message: string }
  | { status: "mismatch"; message: string; path: string; expected: string; actual: string }
  | { status: "unsupported-version"; message: string }
  | { status: "invalid-trace"; errors: ValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mismatch(path: string, expected: unknown, actual: unknown, message: string): ReplayResult {
  return { status: "mismatch", message, path, expected: canonicalStringify(expected), actual: canonicalStringify(actual) };
}

/** Re-run a trace's recorded request and compare every deterministic result field. */
export function verifyReplay(input: unknown): ReplayResult {
  if (!isRecord(input)) return { status: "invalid-trace", errors: [{ path: "trace", message: "must be an object" }] };
  if (input.traceSchemaVersion !== 1) return { status: "unsupported-version", message: "Trace schema version is not supported" };
  if (input.engineVersion !== ENGINE_VERSION) return { status: "unsupported-version", message: `Trace engine version ${String(input.engineVersion)} is not supported by ${ENGINE_VERSION}` };
  if (!isRecord(input.request)) return { status: "invalid-trace", errors: [{ path: "trace.request", message: "must be an object" }] };
  if (input.seed !== input.request.seed) return mismatch("seed", input.request.seed, input.seed, "Trace seed does not match the recorded simulation request");
  if (input.engineVersion !== input.request.engineVersion) return mismatch("engineVersion", input.request.engineVersion, input.engineVersion, "Trace engine version does not match its request");
  if (!Array.isArray(input.entries)) return { status: "invalid-trace", errors: [{ path: "trace.entries", message: "must be an array" }] };

  const requestValidation = validateSimulationRequest(input.request);
  if (!requestValidation.ok || requestValidation.value === undefined) return { status: "invalid-trace", errors: requestValidation.errors };
  const replay = runSimulation(requestValidation.value);
  if (replay.status === "invalid-input") return { status: "invalid-trace", errors: replay.errors };

  if (!isRecord(input.termination)) return { status: "invalid-trace", errors: [{ path: "trace.termination", message: "must be an object" }] };
  if (!isRecord(input.metrics)) return { status: "invalid-trace", errors: [{ path: "trace.metrics", message: "must be an object" }] };

  if (canonicalStringify(input.finalState) !== canonicalStringify(replay.trace.finalState)) return mismatch("finalState", replay.trace.finalState, input.finalState, "Replay final state differs from the recorded final state");
  if (canonicalStringify(input.termination) !== canonicalStringify(replay.trace.termination)) return mismatch("termination", replay.trace.termination, input.termination, "Replay termination differs from the recorded termination");
  if (canonicalStringify(input.metrics) !== canonicalStringify(replay.trace.metrics)) return mismatch("metrics", replay.trace.metrics, input.metrics, "Replay metrics differ from the recorded metrics");
  if (canonicalStringify(input.entries) !== canonicalStringify(replay.trace.entries)) return mismatch("entries", replay.trace.entries, input.entries, "Replay event trace differs from the recorded event trace");
  return { status: "verified", message: "Deterministic replay matched the recorded trace and final state" };
}
