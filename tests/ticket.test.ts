import { test } from "node:test";
import assert from "node:assert/strict";
import { starterMenu } from "../lib/service";
import { finishDraft, matchMenu, parseTicketText } from "../lib/ticket";

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

const ticket = `DoorDash order
Order #A1234
Customer: Test Person
Dasher arrives in 12 min

2 x Burger $18.00
  - no onion
  + extra cheese
1 Fries
1 Classic Pizza
Lobster roll x 2

Subtotal $40.00
Tax $3.00
Total $43.00`;

test("parses a pasted ticket without AI", () => {
  const d = parseTicketText(ticket, menu);
  assert.equal(d.ref, "A1234");
  assert.equal(d.customer, "Test Person");
  assert.equal(d.etaMinutes, 12);
  assert.equal(d.lines.length, 4);
  assert.deepEqual(d.lines[0], {
    name: "Burger",
    qty: 2,
    note: "no onion, extra cheese",
    menuId: named("Burger"),
    uncertain: false,
  });
  assert.equal(d.lines[1].menuId, named("Fries"));
  assert.equal(d.lines[2].uncertain, true);
  assert.equal(d.lines[2].menuId, named("Pizza"));
  assert.equal(d.lines[3].qty, 2);
  assert.equal(d.lines[3].menuId, null);
});

test("prices and totals are never read as dishes", () => {
  const d = parseTicketText("Subtotal 2 x 10\nTotal 40\nTip 5", menu);
  assert.deepEqual(d.lines, []);
});

test("AI output is clamped and matched by the same deterministic rules", () => {
  const d = finishDraft(
    {
      ref: "#99",
      customer: null,
      etaMinutes: 9999,
      lines: [
        { name: "Burger", qty: 500, note: null, unsure: false },
        { name: "Fries", qty: 1, note: "well done", unsure: true },
        { name: "Mystery", qty: 1, note: null, unsure: false },
      ],
    },
    menu,
  );
  assert.equal(d.ref, "99");
  assert.equal(d.etaMinutes, null);
  assert.equal(d.lines[0].qty, 60);
  assert.equal(d.lines[0].uncertain, false);
  // The AI's doubt survives even when the name matches the menu exactly.
  assert.equal(d.lines[1].uncertain, true);
  assert.equal(d.lines[2].menuId, null);
});
