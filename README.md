# Praxis

## What it is

Praxis is an ordering and coordination site for a kitchen handling delivery, walk-in and phone orders. Each order is a receipt with a preparation schedule planned by OR-Tools CP-SAT: recipe steps, station start times, packing and a bag-ready estimate. Staff review a draft, release its instructions, record actual work, check and seal the bag, then confirm pickup.

The Next.js app stores orders, tasks, checks and events in SQLite. `lib/tk/` contains the kitchen rules and planner bridge, `solver/solve.py` runs CP-SAT, `app/api/` exposes actions, and `components/tk/` contains the screens. Scheduling works without AI.

## Setup

Use **Node 22.13+ (22.x) or Node 24+**, with `node:sqlite` available, and **Python 3.9+** with venv/pip support.

```sh
npm install
npm run setup:solver
npm run build
npm start
```

`setup:solver` creates `.venv-solver` and installs OR-Tools there. Open **http://localhost:3100**, review the starter kitchen configuration and choose **Open the board**. The starter values are demo assumptions.

For a separate, fresh demo after building:

```sh
npm run demo
```

Open **http://localhost:3200**. This command deletes `data/demo.db` and its SQLite sidecar files on every run, then starts with that database. Normal startup defaults to `data/timely.db`. Keep separate processes on separate database files.

## Happy-path demo

Use made-up names and notes; this is a manual walkthrough, not evidence of a validated kitchen workflow.

1. **Setup:** run the commands above, open the fresh demo and review stations, equipment capacity, shared staff groups, menu steps and timing assumptions. Select **Open the board**.
2. **New order:** choose **Delivery**, set a driver ETA of 20 minutes, and add a burger with **Well done**, fries and a shake. Add a fictional allergy note to exercise acknowledgement. Choose **Create draft**.
3. **Draft receipt:** review the station schedule, modifiers, allergy flag, bag-ready target and explanation. Drafts may move when the board changes.
4. **Release:** choose **Release to kitchen**. The tasks become issued instructions with a receipt version.
5. **Print once:** open **Print** and print the receipt once. The app records print requests/counts; it cannot verify that paper physically printed.
6. **Change driver ETA:** change the released order's ETA to now. Its issued schedule stays as printed; the earlier target makes it **AT RISK** with the estimated delay shown. Changing an ETA does not silently replace kitchen instructions.
7. **Stations:** select each station, use **Start** when appropriate, then **DONE** when the work is actually finished. Keys **1–9** mark the corresponding visible card done, except while typing or a dialog is open. DONE without Start records an inferred start; timers never complete food automatically. Early actions may require a manager override and reason.
8. **Packing:** once every food step is done, check all food, drinks and extras, acknowledge the allergy note, enter the item count (3 for this order), then **Seal bag**. Drinks count; extras and remakes do not add to the count. Note the assigned shelf slot.
9. **Pickup:** enter the receipt's pickup code. Lookup only identifies the bag; choose **Confirm handoff** to record collection and free its shelf slot.
10. **Remake:** create and release another order, finish its food, then use **Missing?** in Packing before sealing. Give a reason and send the item back to its station. Its linked remake is scheduled urgently and issued when a plan is available; finish it and recheck the item before sealing. A handed-off order cannot be remade; create a new order instead.
11. **Rush Recovery:** with open orders, try a driver change, extra prep time, equipment outage or staff shortage. Review who becomes earlier/later and the risk warnings. Simulation uses a private database copy. Cancel to keep the board, or **Approve and replan drafts** to apply it.
12. **Ask Praxis:** with AI configured, ask which orders are at risk, then request a specific change, such as one grill unit out for 20 minutes. Review its proposal and tap **Approve**. If the board changed, request fresh numbers. Without AI, this panel provides a local board summary only.
13. **Mock outbound:** inspect the delivery receipt's outbound entry, **“Sent to DoorDash (mock)”**. Release and relevant ready-time updates write a local outbound log. No DoorDash request is sent.

## How scheduling works

Time is discretized into **30-second ticks**. Hard constraints cover durations, earliest starts, recipe dependencies, packing after all food/remake steps, equipment capacity, shared staff attendance and outage blocks. Recipes may have multiple dependent steps; packing consumes capacity too.

The staged lexicographic objective preserves each earlier stage's achieved result while optimizing the next:

1. Minimize total lateness against bag-ready targets.
2. Minimize expected courier wait plus piecewise food-holding penalties over early/expected/late arrival scenarios, weighted **25/50/25 by default**.
3. Minimize movement of already planned drafts.
4. Finish components together and avoid finishing unnecessarily before the target.

Remakes get an urgent-placement stage first. Weights, holding penalties and arrival ranges are configurable assumptions. Walk-in/phone orders use their promised pickup time. Targets subtract the configured pickup buffer. Stale driver estimates are flagged and their uncertainty range widens.

**Locked work never moves automatically:** issued instructions retain their printed times; cooking and completed work retain their records. Updated projections account for missed starts and overruns without rewriting the receipt. A manager can withdraw unstarted instructions with a reason, review the replacement draft and release it again. Unrecoverable lateness is shown honestly as **AT RISK**, rather than hidden by an impossible promise. Targets are soft objectives, not hard feasibility constraints.

Solver outcomes are **optimal** (all executed stages proven optimal), **feasible** (valid plan without full optimality proof), **infeasible** (no plan satisfies the constraints), or **unknown** (no conclusion, including timeout). Technical failures may report `invalid` or `error`; no planning work reports `skipped`. If a later optimization stage fails, the worker keeps its last feasible solution. If no feasible plan is returned, previous plans remain visible, failure/warnings are recorded, and new tasks may remain unplanned. An order without a plan cannot be released. Review warnings before relying on retained times.

## Task states

| State | Meaning |
| --- | --- |
| `PLANNED` | Draft work; the scheduler may move it. |
| `ISSUED` | Released instruction; frozen until explicitly withdrawn. |
| `COOKING` | Staff recorded a start; actual work is underway. |
| `DONE` | Staff recorded completion; packing completes when the bag is sealed. |

Order states are separate: draft, released, sealed, handed off or cancelled.

## API

JSON endpoints use internal order/task IDs in paths. Most kitchen actions return an updated `snapshot`; errors include a message and, for rule violations, a code. Mutation actions support `Idempotency-Key` (or `requestId`) for safe retries.

| Method | Path | Purpose / main inputs |
| --- | --- | --- |
| GET | `/api/state` | Current kitchen snapshot and server clock. |
| POST | `/api/settings` | Save `config` and replan drafts. |
| POST | `/api/orders` | Create draft: `channel`, `items`, names, ETA or promised minutes, notes. |
| POST | `/api/orders/{id}/{action}` | `eta`, `issue`, `withdraw`, `cancel`, `check`, `allergen`, `seal`, `handoff`, `remake`, `print`. Action-specific inputs include ETA `minutes`, withdrawal/remake `reason`, check `key`/`checked`, seal `count`, and handoff `code`. |
| POST | `/api/tasks/{id}` | `action`: `start`, `done`, `reopen`, `extend`; optional batch scope, override/reason, extra minutes. |
| POST | `/api/pickup` | Read-only pickup lookup using `code`. |
| POST | `/api/capacity` | Station/pool outage: `kind`, `id`, `unitsOut`, `minutes`. |
| POST | `/api/sample` | Load synthetic orders; `action: "clear"` clears samples. |
| POST | `/api/simulate` | Try `changes` on a private copy. |
| POST | `/api/approve` | Apply `changes` against `baseRev`; stale proposals are rejected. |
| POST | `/api/assistant` | Chat `messages`; local summary or optional AI proposal. |
| GET | `/api/report` | Shift report from recorded events; sample orders excluded. |
| POST | `/api/login` | Shared-passcode session using `passcode`. |

## AI (optional)

Set `OPENROUTER_API_KEY` in `.env.local` (copy `.env.example` as a starting point). The default model is `anthropic/claude-haiku-5.5`. Tools are `get_board`, `what_if`, `propose_changes` and `explain_order`. Scheduling and comparisons come from the kitchen engine and solver. Changes require a person's approval; chat cannot approve them.

The assistant cannot release, start, finish, pack, seal or hand off orders, print receipts, or reopen work. Structured board facts omit customer names, driver names and pickup codes. **Anything typed into chat is sent as written**, so do not include those identifiers in questions. Item names/modifiers can also contain staff-entered text. The key stays on the server.

Assistant and simulation requests share an in-memory limit of **2 concurrent requests and 20 per minute** across devices; restart resets it. AI calls allow up to 5 steps, 500 output tokens and a 40-second timeout, with one retry. Missing/unavailable AI falls back to a local board summary.

## Security and voice

`PRAXIS_PASSCODE` optionally requires a shared passcode. Cross-site API writes are rejected. This is shared access, not individual accounts or manager roles; traffic needs HTTPS for encryption. Customer information is stored unencrypted in SQLite. Use fictional data for demos and do not expose an unprotected board publicly. DoorDash outbound messages are local mocks only.

Voice entry adds **menu dishes in Settings** using browser speech recognition. It requires microphone permission, browser support and **localhost or HTTPS**; a plain HTTP LAN address is insufficient. Typed entry remains available.

## Environment variables

| Variable | Purpose / default |
| --- | --- |
| `OPENROUTER_API_KEY` | Optional server-side AI key; absent means local summary. |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-5.5`. |
| `OPENROUTER_BASE_URL` | Optional compatible endpoint; defaults to `https://openrouter.ai/api/v1`. |
| `PRAXIS_PASSCODE` | Optional shared access passcode; disabled when unset. |
| `PRAXIS_TIMEZONE` | Initial restaurant time-zone default; otherwise the computer's zone. Review saved Settings. |
| `PRAXIS_DB_FILE` | SQLite path; defaults to `data/timely.db`. |
| `PRAXIS_PYTHON` | Python with OR-Tools; otherwise `.venv-solver/bin/python`, then `python3`. |

## Tests

```sh
npm test
npm run build
npx playwright install chromium
npm run test:ui
npm run bench:solver
```

Unit/scenario tests exercise kitchen rules and solver behavior; install the solver first. UI configuration expects a production build, starts port 3101 and uses a throwaway SQLite database. **This checkout currently has no `tests/ui.spec.ts`, which the Playwright configuration selects, so `test:ui` has no matching suite until it is restored.** Solver benchmarks report local timings, not service-readiness evidence.

## Limits and not done

- Prep times, staff attendance, arrival uncertainty and holding penalties are demo assumptions, not verified kitchen measurements or food-safety guarantees.
- DoorDash is mock-only. Orders and driver estimates are entered manually; there are no real DoorDash API calls.
- Screens poll every **2 seconds**; there is no WebSocket transport.
- Intended for one application process and one persistent SQLite file, not distributed deployment.
- Authentication is a shared passcode only; no individual accounts, role enforcement or separate manager credentials.
- Cross-order batching is not supported; compatible portions may batch within an order.
- Old JSON data in `data/service.json` is **not migrated**.
- Remaking a sealed bag requires an explicit manager exception to reopen it; it is not the normal packing path.
- A shadow pilot with measured kitchen timings, real staff procedures and observed outcomes is needed before real use.

### Receipt board and voice questions

Open orders appear as a horizontal row of paired papers: the guest receipt and its station preparation plan. Scroll sideways or use the arrows; on narrow phones the two papers stack within each order.

Ask Praxis supports browser speech recognition on supported browsers over HTTPS or localhost. The browser provides transcription; the returned text stays editable and is never sent automatically. On an HTTP LAN address, use keyboard dictation or typing. Real microphone/provider behavior varies by browser; automated tests simulate the recognition events.

AI tools can read, explain, simulate and propose. Approval validates complete change inputs and the current board revision before applying changes transactionally. Neither chat text nor voice transcripts can approve a proposal. The optional shared passcode protects the board when configured; use a trusted local network for this prototype.
