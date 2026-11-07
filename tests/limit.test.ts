import { test } from "node:test";
import assert from "node:assert/strict";
import { acquire, resetLimits } from "../lib/limit";

test("two at a time, twenty a minute, then it recovers", () => {
  resetLimits();
  const a = acquire(0)!;
  const b = acquire(0)!;
  assert.equal(acquire(0), null);
  a();
  a(); // releasing twice must not free a second slot
  assert.equal(acquire(0)!.constructor, Function);
  assert.equal(acquire(0), null);
  b();
  resetLimits();
  for (let i = 0; i < 20; i++) acquire(i * 1000)!();
  assert.equal(acquire(30_000), null);
  assert.notEqual(acquire(70_000), null);
});
