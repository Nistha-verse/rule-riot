import type { EffectTarget, EntityKind, EventType } from "../domain/types.js";

export const SUPPORTED_EVENT_TYPES: readonly EventType[] = [
  "collision",
  "damage",
  "entity-created",
  "heat-changed",
  "gravity-changed",
  "entity-destroyed",
  "tick",
];

export const SUPPORTED_ENTITY_KINDS: readonly EntityKind[] = ["core", "fragment", "thermal"];
export const SUPPORTED_EFFECT_TARGETS: readonly EffectTarget[] = ["entity", "target", "world"];
export const SUPPORTED_EFFECT_TYPES = ["damage", "create-entity", "change-heat", "change-gravity", "destroy-entity"] as const;
