import { MenuItem } from "./service";

/** Matches a spoken or typed dish name to the menu. A close match still needs a person to confirm it. */
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
