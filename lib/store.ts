import { promises as fs } from "node:fs";
import path from "node:path";
import { Action, Service, emptyService, isService, reduce } from "./service";

/** One JSON file, shared by every device pointed at this server. */
const file = () =>
  process.env.PRAXIS_DATA_FILE ||
  path.join(process.cwd(), "data", "service.json");

export async function load(): Promise<Service> {
  let raw: string;
  try {
    raw = await fs.readFile(file(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyService();
    throw error;
  }
  // Unreadable data stops the app instead of silently starting a blank shift
  // that would overwrite it on the next tap.
  const parsed: unknown = JSON.parse(raw);
  if (!isService(parsed)) throw Error(`Unrecognized data in ${file()}`);
  // Saves made before packing time existed get the default.
  return { ...parsed, packMinutes: parsed.packMinutes ?? 2 };
}

async function save(service: Service) {
  const target = file();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(service));
  await fs.rename(temporary, target);
}

let queue: Promise<unknown> = Promise.resolve();

/** Applies actions one at a time, so simultaneous taps cannot overwrite each other. */
export function apply(action: Action, now = Date.now()): Promise<Service> {
  const run = queue.then(async () => {
    const current = await load();
    const next = reduce(current, action, now);
    if (next !== current) await save(next);
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}
