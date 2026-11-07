import { test } from "node:test";
import assert from "node:assert/strict";
import { starterMenu } from "../lib/service";
import { matchMenu } from "../lib/menu-match";

const menu = starterMenu();
const named = (name: string) => menu.find((m) => m.name === name)!.id;

test("exact and plural names match for certain", () => {
  assert.deepEqual(matchMenu("burger", menu), { menuId: named("Burger"), uncertain: false });
  assert.deepEqual(matchMenu("Burgers", menu), { menuId: named("Burger"), uncertain: false });
  assert.deepEqual(matchMenu("FRIES!", menu), { menuId: named("Fries"), uncertain: false });
});

test("a close name is suggested, but needs a person to confirm it", () => {
  assert.deepEqual(matchMenu("Classic burger", menu), {
    menuId: named("Burger"),
    uncertain: true,
  });
});

test("an unknown dish stays unmatched", () => {
  assert.deepEqual(matchMenu("Lobster roll", menu), { menuId: null, uncertain: true });
});
