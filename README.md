# Praxis

A live kitchen board for restaurants handling delivery orders. Enter orders as they arrive, tap as they move through the kitchen, and Praxis tells you what to cook next so food and couriers meet on time. When something slips, it recalculates and recommends a better order, and nothing changes until you approve it.

## Run it

```sh
npm install
npm run build
npm start
```

Open **http://localhost:3100** and set up your kitchen: name, cooking stations, and menu with prep times. There is nothing else to configure, and no account or API key.

Every device on the same Wi-Fi can open `http://<this-computer's-IP>:3100` and share the same live board, for example a tablet on the line and a phone at the pass. Keep the computer awake during service. Boards update within a few seconds.

## During a shift

1. **New order:** tap the items, confirm the prep time, and pick when the courier arrives.
2. **Start** an order when a station is free. Orders not worth cooking yet show when to start them, so food isn't ready long before the courier.
3. **Ready**, then **Picked up**, as each order moves along.
4. **Problem or change** on any order: it's taking longer, the courier's time changed, the courier is here, move it, or cancel it.
5. If a better cooking order appears, a banner names the change and what it saves. **Review change** shows both versions side by side. **Keep my order** dismisses it.
6. **Undo** (top bar) reverses mistaken taps. **Shift report** shows actual results from the taps recorded. Prep estimates that keep running over are worth raising in Settings.

To try it without real orders, use **Try it with sample orders** on an empty board. Sample orders are labeled, can be cleared, and never count in reports.

## How planning works

Each station is one interchangeable preparation lane that cooks one order at a time. Orders already cooking are never moved or interrupted, and the queue is only reordered with approval.

### Planner definitions

| Term | Meaning |
| --- | --- |
| **Prep time** | Cooking minutes for a whole order: the longest dish, plus 1 minute for each additional dish. Staff can override it on any order. |
| **Packing** | Minutes after cooking for bagging and checking (Settings, default 2). The station is free as soon as cooking ends. |
| **Ready** | Cooking end plus packing. |
| **Courier wait** | Minutes the courier is expected to stand at the counter before the order is ready. |
| **Food sitting** | Minutes ready food is expected to wait for the courier to arrive. |
| **Late** | Minutes ready after the pickup deadline (courier arrival plus the grace period). |
| **Overrun** | Observed only: how much longer cooking took than its estimate. |
| **Aging** | Minutes an order has waited for a station beyond 20 minutes, not counting a deliberate hold. |

Predicted figures (planner, banners, reviews) are estimates from the current board. Observed figures (shift report) come only from taps staff made, such as Ready and Courier here.

### Choosing an order

- **Objective:** minimize `5 × late + 2 × courier wait + 1 × food sitting + 3 × aging`, all in minutes.
- **Search:** with up to 7 queued orders, every possible order is checked. Longer queues use a deterministic heuristic (earliest-deadline insertion, then adjacent swaps), which finds a strong order rather than a proven best one. Run `npm run bench:planner` to see timings. On this machine exact search takes about 8 ms at 7 orders, and the heuristic about 1 ms at 20 and 5 ms at 40.
- **Holds:** an order is held until packing time, cooking time, and a 2-minute buffer before its courier, so short overruns don't cause lateness.

### Keeping recommendations calm

- A suggestion appears only when the gain is worth interrupting the line (a score drop of at least 6, with less total waiting, lateness or aging). Ties keep your current order.
- **Keep my order** silences that exact suggestion for 10 minutes.
- After an approval, the new first order is protected for 3 minutes.
- Approvals are tied to the board version they were shown on. If anything changes first (another device, a courier update), the approval is refused, the review screen asks for a fresh look, and the assistant's proposals must be asked for again.

## Current limits

- **Orders are entered by hand.** There is no live connection to DoorDash or any other platform, because that requires partner API access. Courier times come from what staff see on the merchant tablet, and don't update themselves.
- **One kitchen, one computer.** Data is one file at `data/service.json` (set `PRAXIS_DATA_FILE` to move it). Back it up if your history matters. Hosting that lacks a persistent disk, such as Vercel, won't keep it.
- **No login.** Anyone on the same network can open the board and change it, and customer names are stored unencrypted. Use it only on a network you trust. Don't expose port 3100 to the internet.
- **Stations are interchangeable.** The model doesn't know about grill versus fryer, batching, or tasks that overlap on one ticket.

## AI assistant (optional)

**Ask Praxis** works without AI by giving a summary of the live plan. To let it understand questions and requests, add a key and restart:

```sh
cp .env.example .env.local   # then set OPENROUTER_API_KEY
```

The default model is `anthropic/claude-haiku-5.5`, chosen for reliable tool use at low cost. Set `OPENROUTER_MODEL` to use another model that supports tools.

With a key, staff can ask things like "Can we take 4 burgers with a courier in 15 minutes?" or say "the courier for 1043 is 10 minutes late." The assistant is an agent with three tools:

- `get_board` reads the live orders and plan.
- `what_if` tests changes on a private copy using the real planner.
- `propose_changes` validates changes and shows an **Approve** card.

The model never does the scheduling. Prep times and every before-and-after number come from the planner, and the card's text is generated from the validated change rather than written by the model. It can't change anything itself: only an Approve tap does, those changes apply all-or-nothing, and one Undo reverses them. It can't mark orders started, ready or picked up.

Each question is limited to 5 model steps and 500 output tokens per step, and times out after 20 seconds. Across all devices the board allows 2 questions at a time and 20 per minute. The model receives ticket numbers, items, times and the menu, not customer names, though anything staff type in a question is sent as written. If AI is unavailable, Praxis falls back to the plan summary.

## Development

```sh
npm run dev       # hot reload on port 3100
npm test          # planner, shift rules, storage and the assistant
npm run bench:planner
npm run build
npx playwright install chromium
npm run test:ui   # needs a current build; starts its own server on 3101 with throwaway data
```

`lib/engine.ts` is the planner, `lib/service.ts` holds the shift rules, `lib/store.ts` handles saving, and `components/` holds the screens.

## Presentation

The slide deck at `/demo/index.html` shows the earlier scripted demo. Its screenshots predate this version.
