export type Channel = "delivery" | "walk_in" | "phone";
export type OrderStatus = "DRAFT" | "RELEASED" | "SEALED" | "HANDED_OFF" | "CANCELLED";
/**
 * PLANNED: a draft the scheduler may move.
 * ISSUED: released to staff; start, station, duration and batch are frozen.
 * COOKING: staff recorded a start; never moved.
 * DONE: a person confirmed completion. Never inferred from a timer.
 */
export type TaskStatus = "PLANNED" | "ISSUED" | "COOKING" | "DONE";
export type TaskKind = "food" | "pack" | "remake";

export type Attend =
  | { mode: "full" }
  | { mode: "load_unload"; loadTicks: number; unloadTicks: number };

export type Station = {
  id: string;
  name: string;
  /** Pieces of equipment (burners, baskets, slots) that can run at once. */
  capacity: number;
  /** The shared staff group that works this station. */
  pool: string;
  /** Whether a person is needed all the time, or only to load and unload. */
  attend: Attend;
  /** Most portions that may share one run (a fryer basket). Omit for no batching. */
  batchMax?: number;
};

/** A group of staff who may cover several stations. */
export type Pool = { id: string; name: string; capacity: number };

export type Step = {
  id: string;
  name: string;
  station: string;
  ticks: number;
  /** Earlier steps of the same dish that must finish first. */
  after: string[];
  batchable?: boolean;
};

export type ModifierRule = {
  name: string;
  addTicks: number;
  /** Step the change applies to. Defaults to the first step. */
  step?: string;
};

export type Recipe = {
  id: string;
  name: string;
  category: "food" | "drink";
  steps: Step[];
  modifiers: ModifierRule[];
};

export type Config = {
  version: 1;
  configured: boolean;
  name: string;
  timezone: string;
  clock24: boolean;
  /** Aim to have the bag ready this long before the courier. */
  bufferMinutes: number;
  /** A driver estimate older than this is flagged stale. */
  staleEtaMinutes: number;
  /** Used when an order is entered without any driver estimate. */
  defaultEtaMinutes: number;
  shelfSlots: number;
  packStation: string;
  packTicks: number;
  uncertainty: {
    earlyS: number;
    lateS: number;
    weights: { early: number; expected: number; late: number };
  };
  /** Holding penalties grow after each threshold (in ticks). */
  holding: { after: number[]; slope: number[] };
  solver: { seconds: number; workers: number };
  /** Extras that are easy to forget at the pass. They do not count as items. */
  reminders: string[];
  stations: Station[];
  pools: Pool[];
  recipes: Recipe[];
};

export type OrderRow = {
  id: string;
  number: number;
  channel: Channel;
  source: string;
  customer: string;
  pickup_code: string;
  created_ms: number;
  promised_ms: number | null;
  status: OrderStatus;
  allergen_flag: number;
  allergen_note: string;
  reminders: string;
  driver_name: string;
  driver_id: string;
  plan_version: number;
  released_ms: number | null;
  sealed_ms: number | null;
  handed_off_ms: number | null;
  cancelled_ms: number | null;
  printed_count: number;
  last_print_ms: number | null;
  allergen_ack: number;
  shelf_slot: string | null;
  withdrawn_note: string;
  sample: number;
  last_sent_ready_ms: number | null;
};

export type EstimateRow = {
  order_id: string;
  arrival_ms: number;
  updated_ms: number;
  early_s: number;
  late_s: number;
  source: string;
};

export type ItemRow = {
  id: string;
  order_id: string;
  line: number;
  name: string;
  qty: number;
  recipe_id: string;
  category: string;
  modifiers: string;
  allergen_note: string;
};

export type TaskRow = {
  id: string;
  order_id: string;
  item_id: string | null;
  name: string;
  kind: TaskKind;
  station_id: string;
  duration_ticks: number;
  extra_ticks: number;
  modifiers: string;
  allergen_note: string;
  deps: string;
  status: TaskStatus;
  planned_start_ms: number | null;
  planned_end_ms: number | null;
  actual_start_ms: number | null;
  actual_end_ms: number | null;
  start_inferred: number;
  released_version: number | null;
  batch_id: string | null;
  remake_of: string | null;
  urgent: number;
  portion: number;
  created_ms: number;
};

/** A rule-breaking or impossible request. The message is shown to staff as written. */
export class TkError extends Error {
  constructor(
    message: string,
    readonly code: string = "invalid",
    readonly status: number = 409,
  ) {
    super(message);
  }
}
