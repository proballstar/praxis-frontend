import { createServer } from "node:http";
import { test, expect, Page } from "@playwright/test";

const post = (page: Page, action: object) =>
  page.request.post("/api/service", { data: { action } });

const seed = (page: Page, ref: string, minutes: number, etaMinutes: number) =>
  post(page, {
    type: "addOrder",
    order: {
      ref,
      lines: [{ name: "Test dish", qty: 1, minutes, resource: "oven" }],
      etaMinutes,
    },
  });

const board = async (page: Page) =>
  (await (await page.request.get("/api/service")).json()).service;

const ticket = (page: Page, ref: string) =>
  page.getByRole("article", { name: `Order ${ref}` });

test.describe.configure({ mode: "serial" });

const ticketText = `Order #2047
Customer: Sam Example
Dasher arrives in 18 min

2 x Burger $22.00
  - no onion
1 Fries $5.00
1 Classic Pizza $16.00
1 Lobster roll $19.00

Total $67.50`;

test("the happy path, from an empty install", async ({ page, browser }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // First run: real setup with resources and quality windows.
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Set up your kitchen" }),
  ).toBeVisible();
  await page.getByLabel("Restaurant name").fill("Corner Kitchen");
  await expect(page.getByLabel("Capacity of Grill")).toHaveValue("3");
  await expect(page.getByLabel("Quality window for Fries")).toHaveValue("6");
  await page.getByRole("button", { name: "Open the board" }).click();

  // A calm board with dish-level tickets.
  await page.getByRole("button", { name: "Try it with sample orders" }).click();
  await expect(page.getByLabel("Kitchen resources")).toContainText("Oven 1/1");
  await expect(ticket(page, "1043")).toContainText("2 × Burger");
  await expect(ticket(page, "1043")).toContainText("Fryer");
  await expect(page.getByText(/^Cook #/)).toBeHidden();
  await expect(ticket(page, "1042")).toContainText("On time");
  // The oven is full, so #1044's pizza says so instead of offering a dead button.
  await expect(page.getByRole("button", { name: "Start #1044" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start #1044" })).toContainText(
    "Waiting for oven",
  );

  // Rush Recovery: simulate without touching the live board.
  const original = (await board(page)).orders.find(
    (o: { ref: string }) => o.ref === "1045",
  ).arrival;
  await page.getByRole("button", { name: "Rush Recovery" }).click();
  const rush = page.getByRole("dialog", { name: "Rush Recovery" });
  await rush.getByRole("button", { name: "#1045" }).click();
  await rush.getByRole("button", { name: "15 min" }).click();
  const reorder = rush.getByRole("region", { name: "If you also reorder" });
  await expect(reorder).toContainText("Earlier: #1045 by 12 min");
  await expect(reorder).toContainText("Later: #1044 by 10 min");
  expect(
    (await board(page)).orders.find((o: { ref: string }) => o.ref === "1045")
      .arrival,
  ).toBe(original);

  // Cancelling leaves the plan alone.
  await rush.getByRole("button", { name: "Cancel, keep the current plan" }).click();
  await expect(rush).toBeHidden();
  expect(
    (await board(page)).orders.find((o: { ref: string }) => o.ref === "1045")
      .arrival,
  ).toBe(original);

  // Now approve it.
  await page.getByRole("button", { name: "Rush Recovery" }).click();
  await rush.getByRole("button", { name: "#1045" }).click();
  await rush.getByRole("button", { name: "15 min" }).click();
  await rush.getByRole("button", { name: "Approve change and reorder" }).click();
  await expect(rush).toBeHidden();
  const queue = page.getByRole("region", { name: /Up next/ });
  await expect(queue.locator("article").nth(1)).toContainText("#1045");

  // A second device sees the same board without refreshing.
  const tablet = await (await browser.newContext()).newPage();
  await tablet.goto("/");
  await expect(
    tablet.getByRole("region", { name: /Up next/ }).locator("article").nth(1),
  ).toContainText("#1045");
  await tablet.close();

  // Ticket import: reads the ticket, and blocks until a person resolves it.
  await page.getByRole("button", { name: "New order" }).click();
  const form = page.getByRole("dialog", { name: "New order" });
  await form.getByRole("button", { name: "Import a ticket" }).click();
  await form.getByLabel("Ticket text").fill(ticketText);
  await form.getByRole("button", { name: "Read text" }).click();
  await expect(form.getByLabel("Ticket number")).toHaveValue("2047");
  await expect(form.getByLabel("Customer")).toHaveValue("Sam Example");
  const add = form.getByRole("button", { name: "Add to queue" });
  await expect(add).toBeDisabled();
  await expect(form.getByText("Not on the menu", { exact: true })).toBeVisible();
  await form.getByLabel("Prep minutes for Lobster roll").fill("9");
  await expect(add).toBeDisabled();
  await form
    .getByRole("group", { name: "Review Classic Pizza" })
    .getByLabel("This is right")
    .check();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(form).toBeHidden();
  await expect(ticket(page, "2047")).toContainText("Burger (no onion)");

  await post(page, {
    type: "cancel",
    id: (await board(page)).orders.find((o: { ref: string }) => o.ref === "2047").id,
  });

  // Run one ticket from start to handoff.
  await page.getByRole("button", { name: "Start #1043" }).click();
  await expect(ticket(page, "1043").getByRole("timer").first()).toBeVisible();
  await page.getByRole("button", { name: "Burger done on #1043" }).click();
  await expect(ticket(page, "1043")).toContainText("best for");
  await page.getByRole("button", { name: "Start #1043" }).click();
  await page.getByRole("button", { name: "Fries done on #1043" }).click();
  await page.getByRole("button", { name: "Mark #1043 ready" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Hand off #1043" }).click();

  // Undo recovers a mistaken tap.
  await page.getByRole("button", { name: /^Undo:/ }).click();
  await expect(page.getByRole("button", { name: "Hand off #1043" })).toBeVisible();

  expect(errors).toEqual([]);
});

test("a recommendation is reviewed, and notices a changed board", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Clear samples" }).click();
  await expect(
    page.getByRole("heading", { name: "The board is clear" }),
  ).toBeVisible();

  await seed(page, "1", 14, 6);
  await seed(page, "2", 12, 22);
  await seed(page, "3", 4, 14);
  await page.getByRole("button", { name: "Start #1" }).click();
  await ticket(page, "1").getByRole("button", { name: "Problem or change" }).click();
  await page.getByRole("button", { name: "Add 10 minutes to #1" }).click();

  await expect(page.getByText("Cook #3 before #2")).toBeVisible();
  await page.getByRole("button", { name: "Review change" }).click();
  const review = page.getByRole("dialog", { name: "Review new cooking order" });
  await expect(review).toContainText("Earlier: #3");
  await expect(review).toContainText("Later: #2");

  await seed(page, "4", 2, 60);
  await expect(review.getByText("The board changed")).toBeVisible();
  await expect(review.getByRole("button", { name: "Apply new order" })).toBeHidden();
  await review.getByRole("button", { name: "I’ve checked the new numbers" }).click();
  await review.getByRole("button", { name: "Apply new order" }).click();
  await expect(page.getByText("Cook #3 before #2")).toBeHidden();
  const queue = page.getByRole("region", { name: /Up next/ });
  await expect(queue.locator("article").first()).toContainText("#3");
});

test("freshness: unknown courier times are flagged, never held for", async ({
  page,
}) => {
  await post(page, {
    type: "addOrder",
    order: {
      ref: "9",
      lines: [{ name: "Test dish", qty: 1, minutes: 5, resource: "assembly" }],
      etaMinutes: null,
    },
  });
  await page.goto("/");
  await expect(ticket(page, "9")).toContainText("No courier time");
  await expect(ticket(page, "9")).toContainText("Courier time unknown");
});

test("the phone board fits, and settings too", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("tab", { name: /Up next/ })).toBeVisible();
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);
  expect(await width()).toBeLessThanOrEqual(390);
  await page.getByRole("tab", { name: /Cooking/ }).click();
  await expect(ticket(page, "1")).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("Capacity of Grill")).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);
  await page.getByLabel("Capacity of Grill").fill("4");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByLabel("Kitchen resources")).toContainText("Grill 0/4");
  await page.getByRole("button", { name: "Rush Recovery" }).click();
  await page.getByRole("button", { name: "Equipment down" }).click();
  await expect(page.getByRole("button", { name: "Fryer" })).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);
});

test("an AI proposal changes nothing until someone approves it", async ({
  page,
}) => {
  let step = 0;
  const reply = (message: object, finish_reason: string) =>
    JSON.stringify({
      id: "x",
      created: 1,
      model: "m",
      choices: [{ index: 0, message, finish_reason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  const fake = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        ++step % 2
          ? reply(
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: {
                      name: "propose_changes",
                      arguments: JSON.stringify({
                        changes: [{ kind: "add_time", ticket: "3000", minutes: 7 }],
                      }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : reply({ role: "assistant", content: "Ready for your approval." }, "stop"),
      );
    });
  });
  await new Promise<void>((r) => fake.listen(3199, "127.0.0.1", r));
  try {
    await seed(page, "3000", 10, 30);
    await page.goto("/");
    const extra = async () =>
      (await board(page)).orders.find((o: { ref: string }) => o.ref === "3000")
        .items[0].extra;

    await page.getByRole("button", { name: "Ask Praxis" }).click();
    const chat = page.getByRole("dialog", { name: "Ask Praxis" });
    await chat.getByLabel("Your question").fill("3000 needs 7 more minutes");
    await chat.getByRole("button", { name: "Send" }).click();
    await expect(chat.getByText("Add 7 min to #3000")).toBeVisible();
    expect(await extra()).toBe(0);

    await chat.getByRole("button", { name: "Not now" }).click();
    await expect(chat.getByText("Not applied.")).toBeVisible();
    expect(await extra()).toBe(0);

    await chat.getByLabel("Your question").fill("Actually yes, add it");
    await chat.getByRole("button", { name: "Send" }).click();
    await chat.getByRole("button", { name: "Approve" }).click();
    await expect(chat.getByText("Applied. Undo is in the top bar.")).toBeVisible();
    expect(await extra()).toBe(7);
  } finally {
    fake.close();
    fake.closeAllConnections();
  }
});

test("the API refuses bad requests and other sites", async ({ request }) => {
  const send = (url: string, data: unknown) => request.post(url, { data });
  expect((await send("/api/service", {})).status()).toBe(400);
  expect((await send("/api/service", { action: { type: "x" } })).status()).toBe(409);
  const ask = (messages: unknown) => send("/api/assistant", { messages });
  expect((await ask([])).status()).toBe(400);
  expect((await ask([{ role: "system", content: "x" }])).status()).toBe(400);
  expect(
    (await ask([{ role: "user", content: "x".repeat(1001) }])).status(),
  ).toBe(400);
  expect((await send("/api/import", {})).status()).toBe(400);
  expect(
    (await send("/api/import", { image: "data:text/html;base64,AAAA" })).status(),
  ).toBe(400);
  const crossSite = await request.post("/api/service", {
    data: { action: { type: "undo" } },
    headers: { origin: "https://evil.example" },
  });
  expect(crossSite.status()).toBe(403);
});
