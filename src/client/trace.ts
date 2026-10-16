import type { SimulationTrace } from "../domain/types.js";

export interface TraceCursor {
  trace: SimulationTrace | null;
  index: number;
}

export function createTraceCursor(trace: SimulationTrace | null = null): TraceCursor {
  return { trace, index: trace === null ? -1 : 0 };
}

export function moveTraceCursor(cursor: TraceCursor, delta: number): TraceCursor {
  if (cursor.trace === null) return cursor;
  const last = Math.max(0, cursor.trace.entries.length - 1);
  return { trace: cursor.trace, index: Math.min(last, Math.max(0, cursor.index + delta)) };
}

export function currentTraceEntry(cursor: TraceCursor) {
  return cursor.trace === null || cursor.index < 0 ? null : cursor.trace.entries[cursor.index] ?? null;
}

export function causalChainIds(trace: SimulationTrace, eventId: string | undefined): string[] {
  if (eventId === undefined) return [];
  const byId = new Map(trace.entries.map((entry) => [entry.event.id, entry]));
  const chain: string[] = [];
  let current: string | undefined = eventId;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    current = byId.get(current)?.event.parentEventId;
  }
  return chain;
}
