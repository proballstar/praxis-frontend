import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { defaultConfig } from "./config";
import { Config } from "./types";

// node:sqlite is loaded at run time so the bundler never tries to resolve it.
const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, channel TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '', customer TEXT NOT NULL, pickup_code TEXT NOT NULL,
  created_ms INTEGER NOT NULL, promised_ms INTEGER, status TEXT NOT NULL,
  allergen_flag INTEGER NOT NULL DEFAULT 0, allergen_note TEXT NOT NULL DEFAULT '',
  reminders TEXT NOT NULL DEFAULT '[]', driver_name TEXT NOT NULL DEFAULT '',
  driver_id TEXT NOT NULL DEFAULT '', plan_version INTEGER NOT NULL DEFAULT 1,
  released_ms INTEGER, sealed_ms INTEGER, handed_off_ms INTEGER, cancelled_ms INTEGER,
  printed_count INTEGER NOT NULL DEFAULT 0, last_print_ms INTEGER,
  allergen_ack INTEGER NOT NULL DEFAULT 0, shelf_slot TEXT,
  withdrawn_note TEXT NOT NULL DEFAULT '', sample INTEGER NOT NULL DEFAULT 0,
  last_sent_ready_ms INTEGER
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS driver_estimates (
  order_id TEXT PRIMARY KEY REFERENCES orders(id), arrival_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL, early_s INTEGER NOT NULL, late_s INTEGER NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), line INTEGER NOT NULL,
  name TEXT NOT NULL, qty INTEGER NOT NULL, recipe_id TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'food', modifiers TEXT NOT NULL DEFAULT '[]',
  allergen_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS items_order ON items(order_id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), item_id TEXT,
  name TEXT NOT NULL, kind TEXT NOT NULL, station_id TEXT NOT NULL,
  duration_ticks INTEGER NOT NULL, extra_ticks INTEGER NOT NULL DEFAULT 0,
  modifiers TEXT NOT NULL DEFAULT '[]', allergen_note TEXT NOT NULL DEFAULT '',
  deps TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  planned_start_ms INTEGER, planned_end_ms INTEGER, actual_start_ms INTEGER,
  actual_end_ms INTEGER, start_inferred INTEGER NOT NULL DEFAULT 0,
  released_version INTEGER, batch_id TEXT, remake_of TEXT,
  urgent INTEGER NOT NULL DEFAULT 0, portion INTEGER NOT NULL DEFAULT 1,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_order ON tasks(order_id);
CREATE INDEX IF NOT EXISTS tasks_station ON tasks(station_id, status);
CREATE TABLE IF NOT EXISTS checks (
  order_id TEXT NOT NULL, key TEXT NOT NULL, checked INTEGER NOT NULL,
  checked_ms INTEGER NOT NULL, PRIMARY KEY (order_id, key)
);
CREATE TABLE IF NOT EXISTS shelf (
  slot TEXT PRIMARY KEY, idx INTEGER NOT NULL UNIQUE, order_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
  units INTEGER NOT NULL, from_ms INTEGER NOT NULL, until_ms INTEGER NOT NULL,
  cleared_ms INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, type TEXT NOT NULL,
  order_id TEXT, task_id TEXT, actor TEXT NOT NULL DEFAULT 'staff', payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_order ON events(order_id);
CREATE TABLE IF NOT EXISTS outbound_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, order_id TEXT NOT NULL,
  ready_ms INTEGER NOT NULL, reason TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'mock'
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY, response TEXT NOT NULL, ts_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS solves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, status TEXT NOT NULL,
  ms INTEGER NOT NULL, reason TEXT NOT NULL, warnings TEXT NOT NULL DEFAULT '[]',
  stages TEXT NOT NULL DEFAULT '[]', units INTEGER NOT NULL DEFAULT 0
);
`;

type Param = string | number | null | bigint;

export class Db {
  depth = 0;
  /** Replaceable so tests can run on a fixed clock. */
  clock: () => number = () => Date.now();

  constructor(
    readonly raw: DatabaseSync,
    readonly file: string,
  ) {}

  now() {
    return this.clock();
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]) {
    return this.raw.prepare(sql).run(...params);
  }

  /**
   * One atomic unit of work. Nested calls become savepoints, so an outer
   * failure undoes everything and concurrent writers never see half a change.
   */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    this.raw.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.depth--;
      this.raw.exec(
        this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`,
      );
      throw error;
    }
  }
}

const open = new Map<string, Db>();

export function dbFile() {
  return process.env.PRAXIS_DB_FILE || path.join(process.cwd(), "data", "timely.db");
}

export function openDb(file = dbFile()): Db {
  const cached = open.get(file);
  if (cached) return cached;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const raw = new sqlite.DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  raw.exec(SCHEMA);
  const db = new Db(raw, file);
  open.set(file, db);
  return db;
}

export function closeDb(file = dbFile()) {
  const db = open.get(file);
  if (db) {
    db.raw.close();
    open.delete(file);
  }
}

/** An isolated copy, used for what-if tests. The live database is never touched. */
export function copyDb(source: Db, target: string): Db {
  source.raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const raw = new sqlite.DatabaseSync(target);
  raw.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  const copy = new Db(raw, target);
  copy.clock = source.clock;
  return copy;
}

export const getRev = (db: Db) =>
  Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'rev'")?.value ?? 0);

export function bumpRev(db: Db) {
  db.run(
    "INSERT INTO meta(key, value) VALUES('rev', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1",
  );
}

export function loadConfig(db: Db): Config {
  const row = db.get<{ json: string }>("SELECT json FROM config WHERE id = 1");
  return row ? (JSON.parse(row.json) as Config) : defaultConfig();
}

export function saveConfig(db: Db, config: Config) {
  db.run(
    "INSERT INTO config(id, json) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
    JSON.stringify(config),
  );
  syncShelf(db, config.shelfSlots);
}

/** Keeps one row per configured shelf slot. Occupied slots are never removed. */
export function syncShelf(db: Db, slots: number) {
  for (let i = 1; i <= slots; i++)
    db.run("INSERT OR IGNORE INTO shelf(slot, idx) VALUES(?, ?)", `S${i}`, i);
  db.run("DELETE FROM shelf WHERE idx > ? AND order_id IS NULL", slots);
}

export function logEvent(
  db: Db,
  type: string,
  fields: {
    orderId?: string | null;
    taskId?: string | null;
    actor?: string;
    payload?: unknown;
  } = {},
) {
  db.run(
    "INSERT INTO events(ts_ms, type, order_id, task_id, actor, payload) VALUES(?, ?, ?, ?, ?, ?)",
    db.now(),
    type,
    fields.orderId ?? null,
    fields.taskId ?? null,
    fields.actor ?? "staff",
    JSON.stringify(fields.payload ?? {}),
  );
}
