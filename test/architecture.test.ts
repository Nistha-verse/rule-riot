import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_VERSION } from "../src/index.js";

test("the backend exposes a version for reproducible engine inputs", () => {
  assert.match(ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
});
