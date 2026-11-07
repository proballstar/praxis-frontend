# Praxis

A live kitchen board for restaurants handling delivery orders. Praxis helps staff adapt when the kitchen gets disrupted, keeps food fresh, and cuts order-entry work. It works dish by dish, across named equipment with limited capacity, and tells you what to start next so food and couriers meet on time. It recommends changes, explains who gains and who pays, and changes nothing until someone approves.

## Run it

```sh
npm install
npm run build
npm start
```

Open **http://localhost:3100** and set up your kitchen: resources and their capacity, then your menu with prep times and quality windows. Sensible starter values are filled in. No account or API key is required.

Every device on the same Wi-Fi can open `http://<this-computer's-IP>:3100` and share the same live board. Keep the computer awake during service.

**To demo safely:** `npm run demo` starts a fresh, separate kitchen on port 3200 with its own data file (`data/demo.json`, reset each time). Your real kitchen isn't touched. A synthetic ticket for import is in `public/demo/sample-ticket.txt` and `.png`.

## During a shift

1. **New order:** tap dishes, or **Import a ticket** by pasting its text or uploading a photo. Pick when the courier arrives, or **Not known yet**.
2. **Up next** shows when to start each ticket and when it will be ready. Start what's due. Dishes are timed to finish together, longest first.
3. **Cooking** shows each dish with its timer. Tap **Done** per dish, then **Packed and ready**, then **Picked up**.
4. **Rush Recovery** (life ring, top bar) is for when the plan breaks: a courier early or late, an order needing more time, or equipment down. It simulates on a private copy and shows the result of keeping your order and of reordering, including who gets later. Approve one, or cancel and nothing changes.
5. **Problem or change** on a ticket applies a quick fix directly. If a better order then appears, a banner names it, and **Review change** shows the tradeoff.
6. **Undo** (top bar) reverses mistaken taps, or a whole approved change. **Shift report** shows what actually happened.

Sample orders on an empty board are labeled, can be cleared, and never count in reports.

## How planning works

### Planner definitions

| Term | Meaning |
| --- | --- |
| **Dish** | One unit on a ticket. 2 burgers are two dishes, each using one unit of capacity. |
| **Resource** | A named station with a capacity: how many dishes it can work on at once. Resources are specialized: a dish uses the one its menu entry names. |
| **Prep time** | Active minutes for one dish on its resource. A dish uses one resource, so multi-step recipes are modeled as their longest step. |
| **Packing** | Minutes after the last dish finishes for bagging and checking (Settings, default 2). It uses no resource. |
| **Ready** | Last dish finished, plus packing. |
| **Courier wait** | Predicted minutes the courier stands at the counter before the order is ready. |
| **Food sitting** | Predicted minutes a ready order waits for its courier to arrive. |
| **Late** | Predicted minutes ready after the pickup deadline (courier arrival plus the grace period). |
| **Past quality window** | Predicted minutes a dish will be older than its window at handoff, summed per dish. |
| **Aging** | Minutes a ticket has waited to start beyond 20 minutes, not counting a deliberate hold, so tickets can't stay at the back forever. |
| **Overrun** | Observed only: how much longer a dish took than its estimate. |

**Predicted** figures (board, reviews, Rush Recovery) are estimates from the current board. **Observed** figures (shift report) come only from what staff tapped.

### Choosing an order

The planner decides which ticket gets capacity first. For each candidate order, every dish is placed on a minute-by-minute capacity timeline for its resource, working backward from the ticket's target finish so dishes finish together.

- **Objective:** minimize `5 × late + 2 × courier wait + 1 × food sitting + 3 × aging + 3 × past quality window`, all in minutes.
- **Search:** with up to 6 queued tickets, every possible order is checked. Longer queues use a deterministic heuristic (earliest-deadline insertion, then adjacent swaps), which finds a strong order rather than a proven best one, and the review screen says which was used. `npm run bench:planner` prints timings. On this machine: about 10 ms at 6 tickets of 3 dishes, 10 ms at 20, and 70 ms at 40.
- **Work in progress:** dishes already cooking are never moved, and a started ticket keeps its place at the front. They also keep running through an equipment outage.

### Freshness

- Each dish has a quality window, and the kitchen sets a preparation buffer. Tickets are started so they finish that buffer ahead of the courier. Tickets show when to start and how long that is before pickup.
- A courier time is trusted only while it's fresh. If it's unknown, older than the expiry in Settings, or already past, the ticket is flagged and **not held**: Praxis won't delay food based on a time nobody has confirmed. **Still right** re-confirms it.
- Quality windows are preferences, not food-safety guarantees. Follow your own food-safety rules.

### Keeping recommendations calm

- A suggestion appears only when it's worth interrupting the line (a score drop of at least 6, with less total waiting, lateness, aging or quality loss). Ties keep your current order.
- **Keep my order** silences that exact suggestion for 10 minutes. After an approval, the approved next ticket is protected for 3 minutes.
- Approvals are tied to the board version they were shown on. If anything changes first, the approval is refused and the numbers must be reviewed again, so stale numbers can't be applied. Double taps apply once.
- If nobody approves, the existing plan simply continues.

The numbers are computed, never generated. The reference case (an in-progress order delayed 8 minutes on one lane) still takes courier waiting from 28 to 20 minutes and lateness from 22 to 14. The remaining lateness can't be recovered, and the app says so.

## Current limits

- **Orders aren't connected to any platform.** There is no live DoorDash or Uber Eats integration, because that requires partner API access. Orders come from tapping or ticket import, and courier times don't update themselves.
- **One step per dish.** A burger uses the grill, but not the grill and then assembly. Packing is a flat per-order time with no capacity limit. Batch cooking isn't modeled.
- **One kitchen, one computer.** Data is one file at `data/service.json` (set `PRAXIS_DATA_FILE` to move it). Hosting without a persistent disk, such as Vercel, won't keep it.
- **Voice entry** for menu dishes needs `localhost` or HTTPS, so it doesn't work over the plain phone address, and it isn't available in Firefox.

## Security

- **Passcode:** set `PRAXIS_PASSCODE` in `.env.local` to require a shared passcode on every device. It's off by default. Turn it on before using the board on any network you don't fully trust. It's a single shared passcode without per-person accounts, and traffic isn't encrypted without HTTPS, so don't expose port 3100 to the internet.
- **Cross-site requests** that change the board are refused.
- **Customer names** are stored unencrypted in the data file. Use made-up names in demos.
- **API key:** the OpenRouter key stays on the server and is never sent to the browser. `.env.local` is gitignored.

## AI (optional)

Without a key, everything above still works: **Ask Praxis** gives a plan summary, and pasted tickets are read by a built-in parser. To add AI:

```sh
cp .env.example .env.local   # then set OPENROUTER_API_KEY
```

The default model is `anthropic/claude-haiku-5.5`, chosen for reliable tool use and image reading at low cost. Set `OPENROUTER_MODEL` to use another model with tools and vision.

**Ask Praxis** is an agent with three tools: `get_board` reads the board, `what_if` tests changes on a private copy using the real planner, and `propose_changes` validates changes and shows an **Approve** card. **Ticket import** reads text or photos into a draft.

Guardrails:

- The model never does the scheduling. Times and every before-and-after number come from the planner, and the approval card's text is generated from the validated change, not written by the model.
- It can't change anything itself. Only an Approve tap does, those changes apply all-or-nothing, and one Undo reverses them. It can't mark dishes started, done or picked up.
- Tool inputs have strict types and limits. Ticket contents are treated as data: instructions hidden in a ticket are ignored, and imports always go through staff review, with unmatched and uncertain lines blocking the order until resolved.
- Each question is limited to 5 model steps, 500 output tokens per step, and 20 seconds. Across all devices the board allows 2 AI requests at a time and 20 per minute.
- The assistant receives ticket numbers, items, times and the menu, not customer names. Ticket import does send whatever the ticket contains, and anything typed into a question is sent as written. Use synthetic tickets in demos.
- If AI is unavailable, Praxis falls back to the built-in behavior.

## Development

```sh
npm run dev            # hot reload on port 3100
npm test               # planner, shift rules, storage, tickets, sessions and the assistant
npm run bench:planner
npm run build
npx playwright install chromium
npm run test:ui        # needs a current build; starts its own server on 3101 with throwaway data
```

`lib/engine.ts` is the planner, `lib/service.ts` holds the shift rules, `lib/changes.ts` runs simulations, `lib/ticket.ts` reads tickets, `lib/agent.ts` is the assistant, `lib/store.ts` handles saving, and `components/` holds the screens. Saved kitchens from older versions upgrade automatically: each old station becomes a unit of one "Line" resource.

The slide deck at `/demo/index.html` shows an earlier scripted demo, and its screenshots predate this version.
