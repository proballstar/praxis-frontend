import { MenuItem } from "./service";

/**
 * Turns ticket text into a draft order for staff to review. Nothing here creates
 * an order: unmatched and uncertain lines are flagged for a person to resolve.
 */
export type DraftLine = {
  name: string;
  qty: number;
  note: string;
  menuId: string | null;
  /** The reading or the menu match needs a human check. */
  uncertain: boolean;
};

export type TicketDraft = {
  ref: string;
  customer: string;
  etaMinutes: number | null;
  lines: DraftLine[];
};

const normal = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const singular = (w: string) => (w.length > 3 ? w.replace(/(es|s)$/, "") : w);
const words = (s: string) => normal(s).split(" ").filter(Boolean).map(singular);

export function matchMenu(name: string, menu: MenuItem[]) {
  const wanted = words(name).join(" ");
  const same = menu.find((m) => words(m.name).join(" ") === wanted);
  if (same) return { menuId: same.id, uncertain: false };
  // "Classic burger" probably means Burger, but a person should confirm it.
  const tokens = new Set(words(name));
  const close = menu.filter((m) => {
    const dish = words(m.name);
    return dish.length > 0 && dish.every((w) => tokens.has(w));
  });
  if (close.length === 1) return { menuId: close[0].id, uncertain: true };
  return { menuId: null, uncertain: true };
}

const NOISE =
  /^(sub ?total|total|tax|tip|fee|delivery fee|service fee|discount|thank|thanks|paid|payment|visa|mastercard|amex|cash)\b/i;

export function parseTicketText(text: string, menu: MenuItem[]): TicketDraft {
  const draft: TicketDraft = { ref: "", customer: "", etaMinutes: null, lines: [] };
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const line = raw.trim();
    if (!line) continue;

    const eta = line.match(
      /\b(?:courier|dasher|driver|pickup|pick up|arrives?|eta)\b.*?(\d{1,3})\s*(?:m|min|mins|minutes?)\b/i,
    );
    if (eta) {
      draft.etaMinutes = Number(eta[1]);
      continue;
    }
    const customer = line.match(/^(?:customer|name|for)\s*[:\-]\s*(.+)$/i);
    if (customer) {
      draft.customer = customer[1].trim().slice(0, 60);
      continue;
    }
    const ref = line.match(/^(?:order|ticket|check)?\s*#\s*([a-z0-9-]{1,20})\b/i);
    if (ref) {
      draft.ref = ref[1];
      continue;
    }
    const modifier = line.match(/^(?:[-+*•]\s*|(?=(?:no|extra|add|without|sub|side of)\s))(.+)$/i);
    if (modifier && draft.lines.length) {
      const last = draft.lines[draft.lines.length - 1];
      last.note = [last.note, modifier[1].trim()]
        .filter(Boolean)
        .join(", ")
        .slice(0, 120);
      continue;
    }
    if (NOISE.test(line)) continue;

    const item =
      line.match(/^(\d{1,2})\s*[x×]?\s+(.+?)(?:\s+\$?\d+\.\d{2})?$/i) ??
      line.match(/^()(.+?)\s+[x×]\s*(\d{1,2})$/i);
    if (!item) continue;
    const qty = Number(item[1] || item[3]);
    const name = item[2].trim().slice(0, 80);
    if (!qty || !name) continue;
    draft.lines.push({ name, qty, note: "", ...matchMenu(name, menu) });
  }
  return draft;
}

/** Applies the same deterministic menu match to lines read by the AI. */
export function finishDraft(
  extracted: {
    ref?: string | null;
    customer?: string | null;
    etaMinutes?: number | null;
    lines: { name: string; qty: number; note?: string | null; unsure?: boolean | null }[];
  },
  menu: MenuItem[],
): TicketDraft {
  return {
    ref: (extracted.ref ?? "").replace(/^#/, "").slice(0, 20),
    customer: (extracted.customer ?? "").slice(0, 60),
    etaMinutes:
      Number.isInteger(extracted.etaMinutes) &&
      extracted.etaMinutes! >= 0 &&
      extracted.etaMinutes! <= 240
        ? extracted.etaMinutes!
        : null,
    lines: extracted.lines.slice(0, 40).map((l) => {
      const match = matchMenu(l.name, menu);
      return {
        name: l.name.slice(0, 80),
        qty: Math.min(60, Math.max(1, Math.round(l.qty) || 1)),
        note: (l.note ?? "").slice(0, 120),
        menuId: match.menuId,
        uncertain: match.uncertain || !!l.unsure,
      };
    }),
  };
}
