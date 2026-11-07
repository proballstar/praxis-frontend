/**
 * Turns a spoken phrase such as "add chicken sandwich, nine minutes" into a
 * menu item. Pure: no browser APIs, so it is unit tested.
 */
export type SpokenDish = { name: string; minutes: number };

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const FILLER = new Set([
  "add", "new", "dish", "item", "to", "the", "a", "an", "takes", "take",
  "is", "prep", "time", "for", "at", "in", "of", "on", "with", "and", "it",
  "its", "menu", "called",
]);
const MINUTE_WORDS = new Set(["minute", "minutes", "min", "mins"]);

/** Reads a number ending at `end` (inclusive). Returns the value and first token index. */
function readNumber(tokens: string[], end: number) {
  const word = tokens[end];
  if (word === undefined) return null;
  if (/^\d+$/.test(word)) return { value: Number(word), start: end };
  if (word in TENS && end >= 0) return { value: TENS[word], start: end };
  if (word in UNITS) {
    const before = tokens[end - 1];
    if (before in TENS && UNITS[word] >= 1 && UNITS[word] <= 9)
      return { value: TENS[before] + UNITS[word], start: end - 1 };
    return { value: UNITS[word], start: end };
  }
  return null;
}

export function parseSpokenDish(transcript: string): SpokenDish | null {
  const tokens = transcript
    .toLowerCase()
    .replace(/[-–]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  let end = tokens.length - 1;
  if (end >= 0 && MINUTE_WORDS.has(tokens[end])) end--;
  const found = readNumber(tokens, end);
  if (!found) return null;
  const minutes = found.value;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return null;

  const name = tokens
    .slice(0, found.start)
    .filter((t) => !FILLER.has(t))
    .join(" ")
    .trim();
  if (name.length < 2 || name.length > 60) return null;

  return {
    name: name.replace(/\b\w/g, (c) => c.toUpperCase()),
    minutes,
  };
}
