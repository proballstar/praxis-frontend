import { Db, bumpRev, getRev, logEvent } from "./db";
import { Change, applyChange } from "./changes";
import {
  CapacityInput,
  EtaInput,
  Meta,
  NewOrder,
  RemakeInput,
  TaskAction,
  acknowledgeAllergen,
  cancelOrder,
  clearSample,
  createOrder,
  createRemake,
  execute,
  handoff,
  issueOrder,
  issueRemake,
  loadSample,
  lookupPickup,
  recordPrint,
  sealOrder,
  serial,
  setCapacity,
  setCheck,
  syncOutbound,
  taskAction,
  updateEta,
  updateSettings,
  withdrawOrder,
} from "./engine";
import { replan } from "./planner";
import { Config, TkError } from "./types";

/**
 * Every change to the kitchen goes through here. Each call is atomic, safe to
 * retry with the same requestId, and re-plans only the drafts afterwards.
 */
export const tk = {
  settings: (db: Db, config: Config, meta?: Meta) =>
    execute(db, { reason: "settings", plan: "now", meta }, (now) => updateSettings(db, config, now)),

  createOrder: (db: Db, input: NewOrder, meta?: Meta) =>
    execute(db, { reason: "new order", plan: "now", meta }, (now) => createOrder(db, input, now)),

  updateEta: (db: Db, input: EtaInput, meta?: Meta) =>
    execute(db, { reason: "driver estimate", plan: "now", meta }, (now) => updateEta(db, input, now)),

  /** Re-plans first if the draft's times have gone out of date, so a release is never stale. */
  async issue(db: Db, orderId: string, meta?: Meta) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await execute(db, { reason: "release", plan: "now", meta }, (now) => issueOrder(db, orderId, now));
      } catch (error) {
        if (attempt === 0 && error instanceof TkError && error.code === "stale_plan") {
          await serial(db, () => replan(db, "refresh before release"));
          continue;
        }
        throw error;
      }
    }
  },

  withdraw: (db: Db, orderId: string, reason: string, meta?: Meta) =>
    execute(db, { reason: "withdraw", plan: "now", meta }, (now) => withdrawOrder(db, orderId, reason, now)),

  cancel: (db: Db, orderId: string, force: boolean, meta?: Meta) =>
    execute(db, { reason: "cancel", plan: "soon", meta }, () => cancelOrder(db, orderId, force)),

  task: (db: Db, input: TaskAction, meta?: Meta) =>
    execute(db, { reason: "station", plan: "soon", meta }, (now) => taskAction(db, input, now)),

  check: (db: Db, orderId: string, key: string, checked: boolean, meta?: Meta) =>
    execute(db, { reason: "check", plan: false, meta }, (now) => setCheck(db, orderId, key, checked, now)),

  allergen: (db: Db, orderId: string, acknowledged: boolean, meta?: Meta) =>
    execute(db, { reason: "allergen", plan: false, meta }, () => acknowledgeAllergen(db, orderId, acknowledged)),

  seal: (db: Db, orderId: string, input: { count: number; allergenAck?: boolean }, meta?: Meta) =>
    execute(db, { reason: "seal", plan: "soon", meta }, (now) => sealOrder(db, orderId, input, now)),

  handoff: (db: Db, orderId: string, code: unknown, meta?: Meta) =>
    execute(db, { reason: "handoff", plan: false, meta }, (now) => handoff(db, orderId, code, now)),

  /** A wrong code is logged, then refused, so the rejection survives the failed request. */
  async tryHandoff(db: Db, orderId: string, code: unknown, meta?: Meta) {
    try {
      return await tk.handoff(db, orderId, code, meta);
    } catch (error) {
      if (error instanceof TkError && error.code === "wrong_code")
        await serial(db, () => {
          db.tx(() => {
            db.run(
              "INSERT INTO events(ts_ms, type, order_id, task_id, actor, payload) VALUES(?, 'handoff_rejected', ?, NULL, 'staff', '{}')",
              db.now(),
              orderId,
            );
            bumpRev(db);
          });
        });
      throw error;
    }
  },

  /** Schedules the missing item at the earliest free capacity, then issues it at once. */
  async remake(db: Db, input: RemakeInput, meta?: Meta) {
    const created = await execute(db, { reason: "remake", plan: false, meta }, (now) => createRemake(db, input, now));
    if (created.replayed) return { ...created, issued: [] as string[] };
    let issued: string[] = [];
    await serial(db, async () => {
      await replan(db, "remake", { urgentTaskIds: created.taskIds });
      issued = db.tx(() => {
        const ids = issueRemake(db, created.taskIds);
        bumpRev(db);
        syncOutbound(db);
        return ids;
      });
    });
    return { ...created, issued };
  },

  capacity: (db: Db, input: CapacityInput, meta?: Meta) =>
    execute(db, { reason: "capacity", plan: "now", meta }, (now) => setCapacity(db, input, now)),

  print: (db: Db, orderId: string, meta?: Meta) =>
    execute(db, { reason: "print", plan: false, meta }, (now) => recordPrint(db, orderId, now)),

  loadSample: (db: Db, meta?: Meta) =>
    execute(db, { reason: "sample", plan: "now", meta }, (now) => loadSample(db, now)),

  clearSample: (db: Db, meta?: Meta) =>
    execute(db, { reason: "clear sample", plan: "soon", meta }, () => clearSample(db)),

  /**
   * Applies changes a person approved, all or nothing. They are refused if the
   * board changed after the numbers were shown, so stale numbers are never applied.
   */
  approve: (db: Db, baseRev: number, changes: Change[], meta?: Meta) =>
    execute(db, { reason: "approved changes", plan: "now", meta }, (now) => {
      if (getRev(db) !== baseRev)
        throw new TkError(
          "The board changed after this was proposed, so the numbers may be out of date. Try it again for fresh numbers.",
          "stale_proposal",
          409,
        );
      const lines = changes.map((c) => applyChange(db, c, now));
      logEvent(db, "approved_changes", { actor: "approved", payload: { lines } });
      return { lines };
    }),

  lookup: (db: Db, code: unknown) => lookupPickup(db, code, db.now()),

  rev: getRev,
};
