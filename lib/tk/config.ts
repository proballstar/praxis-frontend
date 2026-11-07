import { defaultTimeZone, isValidTimeZone, minutesToTicks } from "./time";
import { Config, Pool, Recipe, Station, TkError } from "./types";

const m = minutesToTicks;

const stations = (): Station[] => [
  { id: "grill", name: "Grill", capacity: 2, pool: "hot", attend: { mode: "full" } },
  {
    id: "fryer",
    name: "Fryer",
    capacity: 2,
    pool: "hot",
    attend: { mode: "load_unload", loadTicks: 1, unloadTicks: 1 },
    batchMax: 4,
  },
  {
    id: "oven",
    name: "Oven",
    capacity: 1,
    pool: "hot",
    attend: { mode: "load_unload", loadTicks: 1, unloadTicks: 1 },
  },
  { id: "drinks", name: "Drinks", capacity: 1, pool: "cold", attend: { mode: "full" } },
  { id: "assembly", name: "Assembly", capacity: 2, pool: "cold", attend: { mode: "full" } },
  { id: "pack", name: "Pack", capacity: 1, pool: "packer", attend: { mode: "full" } },
];

const pools = (): Pool[] => [
  { id: "hot", name: "Hot line", capacity: 2 },
  { id: "cold", name: "Cold line and drinks", capacity: 1 },
  { id: "packer", name: "Packer", capacity: 1 },
];

const step = (
  id: string,
  name: string,
  station: string,
  minutes: number,
  after: string[] = [],
  batchable = false,
) => ({ id, name, station, ticks: m(minutes), after, ...(batchable ? { batchable } : {}) });

/** Demo assumptions, not verified settings for a real kitchen. */
const recipes = (): Recipe[] => [
  {
    id: "burger",
    name: "Burger",
    category: "food",
    steps: [step("grill", "Grill burger", "grill", 8)],
    modifiers: [
      { name: "well done", addTicks: m(2) },
      { name: "medium rare", addTicks: -m(1) },
    ],
  },
  {
    id: "chicken",
    name: "Chicken sandwich",
    category: "food",
    steps: [
      step("fry", "Fry chicken", "fryer", 6),
      step("build", "Assemble sandwich", "assembly", 1, ["fry"]),
    ],
    modifiers: [],
  },
  {
    id: "fries",
    name: "Fries",
    category: "food",
    steps: [step("fry", "Fry fries", "fryer", 3, [], true)],
    modifiers: [{ name: "extra crispy", addTicks: m(1) }],
  },
  {
    id: "rings",
    name: "Onion rings",
    category: "food",
    steps: [step("fry", "Fry rings", "fryer", 4, [], true)],
    modifiers: [],
  },
  {
    id: "shake",
    name: "Shake",
    category: "drink",
    steps: [step("blend", "Make shake", "drinks", 2)],
    modifiers: [],
  },
  {
    id: "soda",
    name: "Soda",
    category: "drink",
    steps: [step("pour", "Pour soda", "drinks", 1)],
    modifiers: [],
  },
  {
    id: "salad",
    name: "Salad",
    category: "food",
    steps: [step("toss", "Toss salad", "assembly", 3)],
    modifiers: [],
  },
  {
    id: "pizza",
    name: "Pizza",
    category: "food",
    steps: [step("bake", "Bake pizza", "oven", 12)],
    modifiers: [],
  },
];

export function defaultConfig(): Config {
  return {
    version: 1,
    configured: false,
    name: "",
    timezone: defaultTimeZone(),
    clock24: false,
    bufferMinutes: 1,
    staleEtaMinutes: 10,
    defaultEtaMinutes: 20,
    shelfSlots: 12,
    packStation: "pack",
    packTicks: m(1),
    uncertainty: { earlyS: 60, lateS: 180, weights: { early: 25, expected: 50, late: 25 } },
    // Illustrative: holding penalties grow after 2, 6 and 10 minutes.
    holding: { after: [m(2), m(6), m(10)], slope: [1, 2, 4] },
    solver: { seconds: 2, workers: 1 },
    reminders: ["Sauces", "Utensils", "Napkins"],
    stations: stations(),
    pools: pools(),
    recipes: recipes(),
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

function whole(v: unknown, min: number, max: number, label: string) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new TkError(`${label} must be a whole number from ${min} to ${max}.`, "invalid_config", 422);
  return v;
}

/** Cleans a settings object. Throws a message staff can act on. */
export function validateConfig(input: Config): Config {
  const bad = (message: string): never => {
    throw new TkError(message, "invalid_config", 422);
  };
  const name = text(input?.name, 60);
  if (!name) bad("Enter the restaurant name.");
  const timezone = text(input.timezone, 60);
  if (!isValidTimeZone(timezone)) bad(`"${timezone}" is not a time zone. Try a name like America/New_York.`);

  if (!Array.isArray(input.pools) || !input.pools.length) bad("Add at least one staff group.");
  const pools = input.pools.map((p) => {
    const label = text(p?.name, 40);
    if (!label) return bad("Every staff group needs a name.");
    return {
      id: text(p.id, 40) || slug(label),
      name: label,
      capacity: whole(p.capacity, 1, 50, `${label} staff`),
    };
  });
  if (new Set(pools.map((p) => p.id)).size !== pools.length) bad("Two staff groups share a name.");

  if (!Array.isArray(input.stations) || !input.stations.length) bad("Add at least one station.");
  const stations = input.stations.map((s): Station => {
    const label = text(s?.name, 40);
    if (!label) return bad("Every station needs a name.");
    const pool = pools.find((p) => p.id === s.pool);
    if (!pool) return bad(`Choose a staff group for ${label}.`);
    const attend: Station["attend"] =
      s.attend?.mode === "load_unload"
        ? {
            mode: "load_unload",
            loadTicks: whole(s.attend.loadTicks, 0, 20, `${label} loading time`),
            unloadTicks: whole(s.attend.unloadTicks, 0, 20, `${label} unloading time`),
          }
        : { mode: "full" };
    return {
      id: text(s.id, 40) || slug(label),
      name: label,
      capacity: whole(s.capacity, 1, 50, `${label} equipment`),
      pool: pool.id,
      attend,
      ...(s.batchMax && s.batchMax > 1
        ? { batchMax: whole(s.batchMax, 2, 20, `${label} batch size`) }
        : {}),
    };
  });
  if (new Set(stations.map((s) => s.id)).size !== stations.length) bad("Two stations share a name.");
  const packStation = stations.find((s) => s.id === input.packStation)?.id;
  if (!packStation) bad("Choose which station is the packing station.");

  if (!Array.isArray(input.recipes)) bad("The menu could not be read.");
  const recipes = input.recipes
    .filter((r) => text(r?.name, 60))
    .map((r): Recipe => {
      const label = text(r.name, 60);
      if (!Array.isArray(r.steps) || !r.steps.length) return bad(`${label} needs at least one step.`);
      const steps = r.steps.map((s, i) => {
        const station = stations.find((x) => x.id === s?.station);
        if (!station) return bad(`Choose a station for ${label}, step ${i + 1}.`);
        return {
          id: text(s.id, 40) || `s${i + 1}`,
          name: text(s.name, 60) || `${label} step ${i + 1}`,
          station: station.id,
          ticks: whole(s.ticks, 1, 480, `${label} step ${i + 1} time`),
          after: Array.isArray(s.after) ? s.after.map((x) => String(x)) : [],
          ...(s.batchable ? { batchable: true } : {}),
        };
      });
      const seen = new Set<string>();
      for (const s of steps) {
        if (seen.has(s.id)) bad(`${label} has two steps with the same name.`);
        // A step may only wait for earlier steps, which also rules out loops.
        const missing = s.after.find((a) => !seen.has(a));
        if (missing) bad(`${label}: "${s.name}" must come after an earlier step.`);
        seen.add(s.id);
      }
      return {
        id: text(r.id, 40) || slug(label),
        name: label,
        category: r.category === "drink" ? "drink" : "food",
        steps,
        modifiers: (Array.isArray(r.modifiers) ? r.modifiers : [])
          .filter((x) => text(x?.name, 40))
          .map((x) => ({
            name: text(x.name, 40).toLowerCase(),
            addTicks: whole(x.addTicks, -240, 240, `${label} modifier time`),
            ...(x.step && steps.some((s) => s.id === x.step) ? { step: x.step } : {}),
          })),
      };
    });
  if (new Set(recipes.map((r) => r.id)).size !== recipes.length) bad("Two dishes share a name.");

  const w = input.uncertainty?.weights;
  if (!w || w.early < 0 || w.expected < 0 || w.late < 0 || w.early + w.expected + w.late <= 0)
    bad("Arrival scenario weights must be positive.");

  const after = input.holding?.after ?? [];
  const slope = input.holding?.slope ?? [];
  if (!after.length || after.length !== slope.length) bad("Holding penalties need matching thresholds and weights.");

  return {
    version: 1,
    configured: true,
    name,
    timezone,
    clock24: !!input.clock24,
    bufferMinutes: whole(input.bufferMinutes, 0, 30, "Pickup buffer"),
    staleEtaMinutes: whole(input.staleEtaMinutes, 1, 120, "Estimate expiry"),
    defaultEtaMinutes: whole(input.defaultEtaMinutes, 1, 120, "Default driver time"),
    shelfSlots: whole(input.shelfSlots, 1, 60, "Shelf slots"),
    packStation: packStation!,
    packTicks: whole(input.packTicks, 1, 60, "Packing time"),
    uncertainty: {
      earlyS: whole(input.uncertainty.earlyS, 0, 1800, "Early arrival range"),
      lateS: whole(input.uncertainty.lateS, 0, 3600, "Late arrival range"),
      weights: { early: w!.early, expected: w!.expected, late: w!.late },
    },
    holding: {
      after: after.map((a) => whole(a, 0, 240, "Holding threshold")),
      slope: slope.map((a) => whole(a, 1, 20, "Holding weight")),
    },
    solver: {
      seconds: Math.min(30, Math.max(0.5, Number(input.solver?.seconds) || 2)),
      workers: whole(input.solver?.workers ?? 1, 1, 8, "Solver workers"),
    },
    reminders: (Array.isArray(input.reminders) ? input.reminders : [])
      .map((r) => text(r, 40))
      .filter(Boolean)
      .slice(0, 12),
    stations,
    pools,
    recipes,
  };
}

export const stationOf = (c: Config, id: string) => c.stations.find((s) => s.id === id);
