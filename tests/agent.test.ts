import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { runAgent } from "../lib/agent";
import { Change, boardFacts, compile, simulate } from "../lib/changes";
import { Action, Service, emptyService, planFor, reduce } from "../lib/service";
import { apply } from "../lib/store";
import { POST } from "../app/api/assistant/route";

const T0 = Date.UTC(2026, 10, 7, 23, 0);

function board(): Service {
  let n = 0;
  const id = () => `id${++n}`;
  const actions: Action[] = [
    {
      type: "configure",
      settings: {
        name: "K",
        stations: 1,
        graceMinutes: 2, packMinutes: 0,
        menu: [
          { id: "1", name: "Burger", minutes: 8 },
          { id: "2", name: "Salad", minutes: 4 },
        ],
      },
    },
    {
      type: "addOrder",
      order: { ref: "1042", customer: "Secret Name", items: "2 × Bowl", prep: 14, etaMinutes: 6 },
    },
    {
      type: "addOrder",
      order: { ref: "1043", customer: "Secret Name", items: "1 × Pizza", prep: 12, etaMinutes: 22 },
    },
    {
      type: "addOrder",
      order: { ref: "1044", customer: "Secret Name", items: "2 × Salad", prep: 4, etaMinutes: 14 },
    },
    { type: "start", id: "id1" },
  ];
  return actions.reduce((s, a) => reduce(s, a, T0, id), emptyService());
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const call = (toolName: string, input: object) => ({
  content: [
    {
      type: "tool-call" as const,
      toolCallId: `call-${toolName}`,
      toolName,
      input: JSON.stringify(input),
    },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});
const say = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage,
  warnings: [],
});
const script = (...steps: ReturnType<typeof say | typeof call>[]) => {
  let i = 0;
  const seen: unknown[] = [];
  return {
    seen,
    model: new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options.prompt);
        return steps[i++];
      },
    }),
  };
};
const ask = (content: string) => [{ role: "user" as const, content }];

test("menu items get a computed prep time, not a guessed one", () => {
  const { actions, lines } = compile(board(), [
    {
      kind: "add_order",
      items: [
        { name: "burger", qty: 2 },
        { name: "Salad", qty: 1 },
      ],
      minutes: 15,
    },
  ]);
  assert.deepEqual(actions, [
    {
      type: "addOrder",
      order: {
        ref: undefined,
        items: "2 × Burger, 1 × Salad",
        prep: 10,
        etaMinutes: 15,
      },
    },
  ]);
  assert.match(lines[0], /10 min prep/);
});

test("bad changes are refused with a reason the model can relay", () => {
  const s = board();
  const refuses = (c: Change, pattern: RegExp) =>
    assert.throws(() => compile(s, [c]), pattern);
  refuses({ kind: "cancel", ticket: "9999" }, /No open order #9999/);
  refuses({ kind: "add_time", ticket: "1042" }, /required/);
  refuses(
    { kind: "add_order", items: [{ name: "Lobster", qty: 1 }], minutes: 9 },
    /isn't on the menu/,
  );
  assert.throws(
    () => simulate(s, T0, [{ kind: "set_stations", stations: 0 }]),
    /Stations must be/,
  );
});

test("what-if numbers match the real board and leave it untouched", () => {
  const s = board();
  const before = structuredClone(s);
  const r = simulate(s, T0, [{ kind: "add_time", ticket: "1042", minutes: 0 + 5 }]);
  assert.deepEqual(s, before);
  const live = reduce(s, r.proposal.actions[0], T0);
  assert.deepEqual(r.facts.after, planFor(live, T0).current.metrics);
  assert.equal(r.proposal.before.wait, planFor(s, T0).current.metrics.wait);
});

test("approved changes apply together, and one undo reverses them", () => {
  const s = board();
  const { actions } = compile(s, [
    { kind: "add_time", ticket: "1042", minutes: 5 },
    { kind: "cancel", ticket: "1043" },
    { kind: "apply_recommended" },
  ]);
  const next = reduce(s, { type: "batch", label: "changes", baseRev: s.rev, actions }, T0);
  assert.equal(next.rev, s.rev + 1);
  assert.equal(next.orders[1].status, "cancelled");
  const undone = reduce(next, { type: "undo" }, T0);
  assert.deepEqual(undone.orders, s.orders);
  assert.deepEqual(undone.queue, s.queue);
});

test("a batch with one bad change applies nothing", () => {
  const s = board();
  const actions: Action[] = [
    { type: "cancel", id: "id2" },
    { type: "cancel", id: "missing" },
  ];
  assert.throws(() => reduce(s, { type: "batch", label: "x", baseRev: s.rev, actions }, T0));
  assert.equal(s.orders[1].status, "queued");
  assert.throws(
    () =>
      reduce(
        s,
        { type: "batch", label: "x", baseRev: s.rev, actions: [{ type: "undo" }] },
        T0,
      ),
    /together/,
  );
});

test("the agent reasons through what_if and changes nothing", async () => {
  const s = board();
  const before = structuredClone(s);
  const { model, seen } = script(
    call("get_board", {}),
    call("what_if", {
      changes: [
        {
          kind: "add_order",
          items: [{ name: "Burger", qty: 2 }],
          minutes: 15,
        },
      ],
    }),
    say("Yes, but it adds courier waiting."),
  );
  const r = await runAgent({
    service: s,
    now: T0,
    messages: ask("Can we take two burgers?"),
    model,
  });
  assert.equal(r.text, "Yes, but it adds courier waiting.");
  assert.equal(r.proposal, null);
  assert.deepEqual(s, before);
  assert.equal(seen.length, 3);
  const sent = JSON.stringify(seen);
  assert.match(sent, /"before"/);
  assert.doesNotMatch(sent, /Secret Name/);
});

test("the agent can only propose; the proposal still needs a tap", async () => {
  const s = board();
  const { model } = script(
    call("propose_changes", {
      changes: [{ kind: "add_time", ticket: "1042", minutes: 8 }],
    }),
    say("Ready for your approval."),
  );
  const r = await runAgent({
    service: s,
    now: T0,
    messages: ask("#1042 needs eight more minutes"),
    model,
  });
  assert.deepEqual(r.proposal?.lines, ["Add 8 min to #1042"]);
  assert.equal(s.orders[0].extra, 0);
  const applied = reduce(
    s,
    {
      type: "batch",
      label: "x",
      baseRev: r.proposal!.baseRev,
      actions: r.proposal!.actions,
    },
    T0,
  );
  assert.equal(applied.orders[0].extra, 8);
});

test("a rejected proposal reaches the model and produces no button", async () => {
  const { model, seen } = script(
    call("propose_changes", { changes: [{ kind: "cancel", ticket: "7" }] }),
    say("I can't find #7."),
  );
  const r = await runAgent({
    service: board(),
    now: T0,
    messages: ask("cancel 7"),
    model,
  });
  assert.equal(r.proposal, null);
  assert.match(JSON.stringify(seen[1]), /No open order #7/);
});

test("the agent cannot loop forever", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls++;
      return call("get_board", {});
    },
  });
  await runAgent({ service: board(), now: T0, messages: ask("loop"), model });
  assert.equal(calls, 5);
});

test("board facts contain no customer names", () => {
  assert.doesNotMatch(JSON.stringify(boardFacts(board(), T0)), /Secret Name/);
});

test("the route speaks OpenRouter's format and falls back on failure", async () => {
  process.env.PRAXIS_DATA_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), "praxis-agent-")),
    "service.json",
  );
  await apply({
    type: "configure",
    settings: {
      name: "K",
      stations: 1,
      graceMinutes: 2, packMinutes: 0,
      menu: [{ id: "1", name: "Burger", minutes: 8 }],
    },
  });
  await apply({
    type: "addOrder",
    order: { ref: "55", customer: "Secret Name", items: "1 × Burger", prep: 8, etaMinutes: 9 },
  });

  const requests: { auth?: string; body: any }[] = [];
  let failing = false;
  const fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (failing) {
        res.writeHead(401).end(JSON.stringify({ error: { message: "bad key" } }));
        return;
      }
      const body = JSON.parse(raw);
      requests.push({ auth: req.headers.authorization, body });
      const message =
        requests.length === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "propose_changes",
                    arguments: JSON.stringify({
                      changes: [{ kind: "cancel", ticket: "55" }],
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Ready for your approval." };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              message,
              finish_reason: requests.length === 1 ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const { port } = fake.address() as { port: number };
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
  delete process.env.OPENROUTER_MODEL;
  const post = () =>
    POST(
      new Request("http://x/api/assistant", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "cancel 55" }],
        }),
      }),
    ).then((r) => r.json());

  try {
    const body = await post();
    assert.equal(body.mode, "openrouter");
    assert.equal(body.answer, "Ready for your approval.");
    assert.deepEqual(body.proposal.lines, ["Cancel #55"]);
    assert.equal(requests[0].auth, "Bearer test-key");
    assert.equal(requests[0].body.model, "anthropic/claude-haiku-5.5");
    assert.deepEqual(
      requests[0].body.tools.map((t: any) => t.function.name),
      ["get_board", "what_if", "propose_changes"],
    );
    assert.doesNotMatch(JSON.stringify(requests), /Secret Name/);

    failing = true;
    const fallback = await post();
    assert.equal(fallback.mode, "local");
    assert.match(fallback.answer, /#55/);
    assert.equal(fallback.proposal, undefined);
  } finally {
    fake.close();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.PRAXIS_DATA_FILE;
  }
});
