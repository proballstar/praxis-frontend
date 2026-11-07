import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpokenDish } from "../lib/dish-speech";

const cases: [string, { name: string; minutes: number } | null][] = [
  ["burger eight minutes", { name: "Burger", minutes: 8 }],
  ["Burger, 8 minutes.", { name: "Burger", minutes: 8 }],
  ["chicken sandwich nine minutes", { name: "Chicken Sandwich", minutes: 9 }],
  ["Add fries four minutes", { name: "Fries", minutes: 4 }],
  ["add a rice bowl takes seven minutes", { name: "Rice Bowl", minutes: 7 }],
  ["spicy tuna roll, twenty five minutes", { name: "Spicy Tuna Roll", minutes: 25 }],
  ["pizza twelve", { name: "Pizza", minutes: 12 }],
  ["pizza 12 min", { name: "Pizza", minutes: 12 }],
  ["hot-dog six minute", { name: "Hot Dog", minutes: 6 }],
  ["soup ninety minutes", { name: "Soup", minutes: 90 }],
  ["soup 0 minutes", null],
  ["soup", null],
  ["eight minutes", null],
  ["x 5", null],
  ["", null],
];

for (const [input, expected] of cases)
  test(`parses "${input}"`, () => {
    assert.deepEqual(parseSpokenDish(input), expected);
  });
