import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, validateConfig } from "../lib/tk/config";
import { Db, closeDb, openDb, saveConfig } from "../lib/tk/db";
import { Config } from "../lib/tk/types";

/** 6:05 PM Eastern on 7 Nov 2026, matching the example in the spec. */
export const T0 = Date.UTC(2026, 10, 7, 23, 5, 0);
export const MIN = 60_000;
export const ZONE = "America/New_York";

export type Fresh = { db: Db; set: (ms: number) => void; advance: (min: number) => void; file: string };

/** A new, empty kitchen in a temporary file, on a clock the test controls. */
export function fresh(patch: (c: Config) => void = () => {}, now = T0): Fresh {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "tk-")), "timely.db");
  const db = openDb(file);
  let clock = now;
  db.clock = () => clock;
  const config = defaultConfig();
  config.name = "Test Kitchen";
  config.timezone = ZONE;
  patch(config);
  saveConfig(db, validateConfig(config));
  return {
    db,
    file,
    set: (ms) => (clock = ms),
    advance: (min) => (clock += min * MIN),
  };
}

export const done = (f: Fresh) => closeDb(f.file);
