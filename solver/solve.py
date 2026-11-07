"""
TimelyKitchen scheduling worker (OR-Tools CP-SAT).

Reads one JSON problem on stdin and writes one JSON answer on stdout.
All times are integer ticks (30 seconds each) relative to an origin the caller
chose. Locked work (issued, cooking) arrives with a fixed start and is never
moved. The solve is staged so priorities are strict, not just weighted:

  1. minimize total lateness against each order's target bag-ready tick
  2. keeping stage 1's result, minimize expected courier wait plus food holding
     across early / expected / late arrival scenarios
  3. keeping stage 2's result, minimize changes to drafts that already had a plan
  4. keeping stage 3's result, finish components together and not before target

Hard constraints: durations, release times, precedence, pack after every food
component, equipment capacity, and shared staff capacity. A target that cannot
be met is never a hard constraint; it shows up as lateness.
"""
import json
import sys
import time

from ortools.sat.python import cp_model

STATUS = {
    cp_model.OPTIMAL: "optimal",
    cp_model.FEASIBLE: "feasible",
    cp_model.INFEASIBLE: "infeasible",
    cp_model.MODEL_INVALID: "invalid",
    cp_model.UNKNOWN: "unknown",
}


def attend_intervals(model, unit, start, end, tag):
    """Intervals during which a worker must be present for this unit."""
    attend = unit.get("attend") or {"mode": "full"}
    dur = unit["dur"]
    if attend.get("mode") == "load_unload":
        load = max(0, int(attend.get("load", 0)))
        unload = max(0, int(attend.get("unload", 0)))
        if load + unload < dur and (load or unload):
            out = []
            if load:
                out.append(model.NewFixedSizeIntervalVar(start, load, f"load_{tag}"))
            if unload:
                out.append(
                    model.NewFixedSizeIntervalVar(end - unload, unload, f"unload_{tag}")
                )
            return out
    return [model.NewFixedSizeIntervalVar(start, dur, f"attend_{tag}")]


def solve(problem):
    started = time.time()
    horizon = int(problem["horizon"])
    total_seconds = float(problem.get("seconds", 3.0))
    workers = int(problem.get("workers", 1))
    seed = int(problem.get("seed", 1))
    weights = problem["weights"]
    units = problem["units"]
    by_id = {u["id"]: u for u in units}

    model = cp_model.CpModel()
    start, end, interval = {}, {}, {}
    warnings = []

    for u in units:
        uid, dur = u["id"], int(u["dur"])
        fixed = u.get("fixed_start")
        if fixed is not None:
            start[uid] = int(fixed)
            end[uid] = int(fixed) + dur
        else:
            earliest = int(u["earliest"])
            if earliest + dur > horizon:
                return {
                    "status": "infeasible",
                    "warnings": [f"{uid} cannot fit inside the planning horizon."],
                    "stages": [],
                    "solve_ms": int((time.time() - started) * 1000),
                }
            start[uid] = model.NewIntVar(earliest, horizon - dur, f"s_{uid}")
            end[uid] = start[uid] + dur
        interval[uid] = model.NewFixedSizeIntervalVar(start[uid], dur, f"i_{uid}")

    for u in units:
        for dep in u.get("deps", []):
            if dep in by_id and dep != u["id"]:
                model.Add(start[u["id"]] >= end[dep])

    # Equipment capacity per station, with blocked segments for outages.
    for st in problem["stations"]:
        ivs, dem = [], []
        for u in units:
            if u["station"] == st["id"]:
                ivs.append(interval[u["id"]])
                dem.append(1)
        for i, b in enumerate(st.get("blocked", [])):
            ivs.append(
                model.NewFixedSizeIntervalVar(
                    int(b["start"]), int(b["end"]) - int(b["start"]), f"x_{st['id']}_{i}"
                )
            )
            dem.append(int(b["units"]))
        if ivs:
            model.AddCumulative(ivs, dem, int(st["capacity"]))

    # Shared staff capacity per worker pool (a person can cover several stations).
    for pool in problem["pools"]:
        ivs, dem = [], []
        for u in units:
            if u.get("pool") == pool["id"]:
                for iv in attend_intervals(model, u, start[u["id"]], end[u["id"]], u["id"]):
                    ivs.append(iv)
                    dem.append(1)
        for i, b in enumerate(pool.get("blocked", [])):
            ivs.append(
                model.NewFixedSizeIntervalVar(
                    int(b["start"]), int(b["end"]) - int(b["start"]), f"w_{pool['id']}_{i}"
                )
            )
            dem.append(int(b["units"]))
        if ivs:
            model.AddCumulative(ivs, dem, int(pool["capacity"]))

    orders = [o for o in problem["orders"] if o.get("pack") in by_id]
    ready = {o["id"]: end[o["pack"]] for o in orders}
    late = {}
    for o in orders:
        v = model.NewIntVar(0, horizon, f"late_{o['id']}")
        model.AddMaxEquality(v, [ready[o["id"]] - int(o["target"]), 0])
        late[o["id"]] = v
    total_late = sum(late.values()) if late else 0

    free = [u for u in units if u.get("fixed_start") is None]

    def hint(values):
        # CP-SAT rejects a model that hints the same variable twice.
        model.ClearHints()
        for u in free:
            v = values.get(u["id"])
            if v is not None:
                model.AddHint(start[u["id"]], int(v))

    hint({u["id"]: u.get("hint") for u in free})

    stage_log = []
    solution = {}
    remaining = lambda: total_seconds - (time.time() - started)

    def run(name, fraction, objective):
        budget = max(0.2, remaining() * fraction)
        if remaining() < 0.15 and stage_log:
            warnings.append(f"Stopped before the '{name}' stage: out of time.")
            return None
        model.Minimize(objective)
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = budget
        solver.parameters.num_workers = workers
        solver.parameters.random_seed = seed
        t0 = time.time()
        status = solver.Solve(model)
        entry = {
            "name": name,
            "status": STATUS.get(status, "unknown"),
            "wall_ms": int((time.time() - t0) * 1000),
        }
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            entry["objective"] = int(round(solver.ObjectiveValue()))
            entry["_solution"] = {
                u["id"]: start[u["id"]]
                if isinstance(start[u["id"]], int)
                else int(solver.Value(start[u["id"]]))
                for u in units
            }
        stage_log.append(entry)
        return entry

    def keep(entry):
        solution.clear()
        solution.update(entry["_solution"])
        hint(entry["_solution"])  # later stages start from this solution

    # Urgent work (a remake) is placed as early as capacity allows, before anything else.
    urgent = [u for u in free if u["id"] in set(problem.get("urgent", []))]
    if urgent:
        urgent_end = sum(end[u["id"]] for u in urgent)
        s0 = run("urgent", 0.3, urgent_end)
        if s0 is not None and "_solution" in s0:
            keep(s0)
            model.Add(urgent_end <= s0["objective"])

    # Stage 1: lateness.
    s1 = run("lateness", 0.4, total_late)
    if s1 is None or "_solution" not in s1:
        status = s1["status"] if s1 else "unknown"
        return {
            "status": status,
            "warnings": warnings
            + ["No feasible plan was found. Previous plans were kept for human review."],
            "stages": [{k: v for k, v in e.items() if not k.startswith("_")} for e in stage_log],
            "solve_ms": int((time.time() - started) * 1000),
        }
    keep(s1)
    model.Add(total_late <= s1["objective"])

    # Stage 2: expected courier wait and food holding across arrival scenarios.
    thresholds = weights["hold"]
    wait_weight = int(weights["wait"])
    terms = []
    for o in orders:
        food = [by_id[f] for f in o.get("food", []) if f in by_id]
        done = o.get("done_ends", [])
        for si, sc in enumerate(o["scenarios"]):
            w = int(sc["weight"])
            arrival = int(sc["arrival"])
            pickup = model.NewIntVar(0, horizon * 2, f"pick_{o['id']}_{si}")
            model.AddMaxEquality(pickup, [ready[o["id"]], arrival])
            terms.append(w * wait_weight * (pickup - arrival))
            holds = [(end[u["id"]], int(u.get("weight", 1))) for u in food]
            holds += [(int(d["end"]), int(d.get("weight", 1))) for d in done]
            for hi, (finish, uw) in enumerate(holds):
                for ti, t in enumerate(thresholds):
                    ex = model.NewIntVar(0, horizon * 2, f"h_{o['id']}_{si}_{hi}_{ti}")
                    model.AddMaxEquality(ex, [pickup - finish - int(t["after"]), 0])
                    terms.append(w * uw * int(t["slope"]) * ex)
    expected = sum(terms) if terms else 0
    s2 = run("wait_and_holding", 0.3, expected)
    if s2 is not None and "_solution" in s2:
        keep(s2)
        model.Add(expected <= s2["objective"])
    elif s2 is not None:
        warnings.append("Wait and holding could not be improved in the time limit.")

    # Stage 3: stability of drafts that already had a plan.
    changes = []
    for u in free:
        if u.get("prev") is None:
            continue
        prev = int(u["prev"])
        moved = model.NewBoolVar(f"mv_{u['id']}")
        model.Add(start[u["id"]] != prev).OnlyEnforceIf(moved)
        model.Add(start[u["id"]] == prev).OnlyEnforceIf(moved.Not())
        gap = model.NewIntVar(0, horizon, f"gap_{u['id']}")
        model.AddAbsEquality(gap, start[u["id"]] - prev)
        changes.append(int(weights["stability"]) * moved + gap)
    if changes:
        stability = sum(changes)
        s3 = run("draft_stability", 0.5, stability)
        if s3 is not None and "_solution" in s3:
            keep(s3)
            model.Add(stability <= s3["objective"])

    # Stage 4: finish together, and not earlier than the target needs.
    tie = []
    for o in orders:
        early = model.NewIntVar(0, horizon, f"early_{o['id']}")
        model.AddMaxEquality(early, [int(o["target"]) - ready[o["id"]], 0])
        tie.append(1000 * early)
        for f in o.get("food", []):
            if f in by_id:
                tie.append(int(by_id[f].get("weight", 1)) * (ready[o["id"]] - end[f]))
    if tie:
        s4 = run("finish_together", 1.0, sum(tie))
        if s4 is not None and "_solution" in s4:
            keep(s4)

    statuses = [e["status"] for e in stage_log]
    overall = "optimal" if all(s == "optimal" for s in statuses) else "feasible"
    if overall == "feasible":
        warnings.append(
            "A feasible plan was found but not proven optimal within the time limit."
        )
    # The plan reports the last stage that found a solution.
    result_units = {}
    for u in units:
        s = solution[u["id"]]
        result_units[u["id"]] = {"start": s, "end": s + int(u["dur"])}
    result_orders = {}
    for o in orders:
        pack = result_units[o["pack"]]["end"]
        l = max(0, pack - int(o["target"]))
        scenarios = o["scenarios"]
        total_w = sum(int(sc["weight"]) for sc in scenarios) or 1
        result_orders[o["id"]] = {
            "ready": pack,
            "late": l,
            "expected_wait": sum(
                int(sc["weight"]) * max(0, pack - int(sc["arrival"])) for sc in scenarios
            )
            / total_w,
        }
    return {
        "status": overall,
        "stages": [{k: v for k, v in e.items() if not k.startswith("_")} for e in stage_log],
        "units": result_units,
        "orders": result_orders,
        "warnings": warnings,
        "solve_ms": int((time.time() - started) * 1000),
    }


def main():
    try:
        problem = json.load(sys.stdin)
        json.dump(solve(problem), sys.stdout)
    except Exception as error:  # report, never crash the caller
        json.dump({"status": "error", "warnings": [f"Solver error: {error}"], "stages": []}, sys.stdout)


if __name__ == "__main__":
    main()
