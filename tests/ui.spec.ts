import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Snapshot } from '../lib/tk/snapshot';

test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'America/Los_Angeles' });

async function state(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/state');
  expect(response.ok()).toBeTruthy();
  return (await response.json()).snapshot;
}

// Projected times, risk and driver age advance with real time. These fields
// capture the recorded orders and issued instructions instead.
function recordedOrders(snapshot: Snapshot) {
  return snapshot.orders.map((order) => ({
    id: order.id, number: order.number, status: order.status,
    customer: order.customer, channel: order.channel, pickupCode: order.pickupCode,
    arrivalMs: order.driver?.arrivalMs, items: order.items,
    reminders: order.reminders, allergen: order.allergen,
    slot: order.slot, sealedMs: order.sealedMs, printed: order.printed,
    version: order.plan.version, releasedMs: order.plan.releasedMs,
    tasks: order.tasks.map(({ projectedStartMs, projectedEndMs, slid, ...task }) => {
      void projectedStartMs; void projectedEndMs; void slid;
      return task;
    }),
  }));
}

async function releasedBurger(page: Page) {
  const response = await page.request.post('/api/orders', {
    data: { channel: 'delivery', customer: 'Shortcut guest', etaMinutes: 20,
      items: [{ recipe: 'burger', qty: 1 }] },
  });
  expect(response.ok()).toBeTruthy();
  const { result } = await response.json();
  const issued = await page.request.post(`/api/orders/${result.orderId}/issue`, { data: {} });
  expect(issued.ok()).toBeTruthy();
  return result as { orderId: string; number: number };
}

async function view(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Views' })
    .getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

function normalizeClock(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

test('empty install through receipt, stations, packing and pickup', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your kitchen. All in sync.' })).toBeVisible();
  await expect(page.getByLabel('Restaurant name', { exact: true })).toHaveCSS('min-height', '44px');
  await page.getByLabel('Restaurant name', { exact: true }).fill('Praxis test kitchen');
  await page.getByRole('button', { name: 'Open the board', exact: true }).click();
  const clock = page.getByRole('timer', { name: /^Restaurant time/ });
  await expect(clock).toBeVisible();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit',
  });
  await expect.poll(async () => {
    const shown = normalizeClock((await clock.getAttribute('aria-label'))!.replace(/^Restaurant time /, ''));
    return [-1, 0, 1].some((offset) =>
      shown === normalizeClock(formatter.format(new Date(Date.now() + offset * 60_000))));
  }).toBe(true);
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
    .toBe('America/Los_Angeles');
  const browserTime = await page.evaluate(() => new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit',
  }).format(new Date()));
  expect(normalizeClock((await clock.getAttribute('aria-label'))!.replace(/^Restaurant time /, '')))
    .not.toBe(normalizeClock(browserTime));

  await page.getByRole('button', { name: 'New order', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New order', exact: true });
  await sheet.getByRole('button', { name: 'Delivery', exact: true }).click();
  await sheet.getByRole('button', { name: '20 min', exact: true }).click();
  for (const item of ['Burger', 'Fries', 'Shake']) {
    await sheet.getByRole('button', { name: item, exact: true }).click();
  }
  await sheet.getByRole('button', { name: 'Create draft (3 items)', exact: true }).click();
  const order = page.getByRole('article', { name: 'Order 101', exact: true });
  await expect(order).toBeVisible();
  for (const item of ['Burger', 'Fries', 'Shake']) {
    await expect(order.getByRole('region', { name: 'Items', exact: true })).toContainText(item);
  }
  await expect(order.getByText('DRAFT', { exact: true })).toBeVisible();
  await expect(order.getByLabel('Preparation plan', { exact: true })).toBeVisible();
  await order.getByRole('button', { name: 'Release to kitchen', exact: true }).click();
  await expect(order).toContainText('ISSUED');
  const href = await order.getByRole('link', { name: /^Print/ }).getAttribute('href');
  expect(href).toMatch(/^\/print\/[^/]+$/);
  await page.addInitScript(() => {
    window.print = () => { document.documentElement.dataset.printCalled = 'yes'; };
  });
  await page.goto(href!);
  const receipt = page.getByRole('article', { name: 'Receipt for order 101', exact: true });
  await expect(receipt).toContainText('ISSUED');
  for (const text of ['Burger', 'Fries', 'Shake', 'A101', 'Check and bag']) {
    await expect(receipt).toContainText(text);
  }
  await page.getByRole('button', { name: 'Print receipt', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-print-called', 'yes');
  await page.goto('/');
  await view(page, 'Stations');
  for (const [station, dish] of [['Grill', 'Burger'], ['Fryer', 'Fries'], ['Drinks', 'Shake']]) {
    await page.getByRole('tab', { name: new RegExp(`^${station}`) }).click();
    const card = page.getByRole('article', { name: `${dish} for order 101`, exact: true });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /^Done:/ }).click();
    const override = card.getByRole('group', { name: 'Manager override' });
    await expect(override).toContainText('Not ready yet');
    await override.getByLabel('Reason for finishing early').fill('Manager verified finished food for UI test');
    await override.getByRole('button', { name: 'Done early (recorded)', exact: true }).click();
    await expect(card).toHaveCount(0);
  }
  await view(page, 'Packing');
  const pack = page.getByRole('article', { name: 'Pack order 101', exact: true });
  await expect(pack).toBeVisible();
  await expect(pack.getByRole('heading', { name: 'EASY TO FORGET', exact: true })).toBeVisible();
  const checks = pack.getByRole('checkbox');
  expect(await checks.count()).toBeGreaterThan(3);
  for (let index = 0; index < await checks.count(); index++) {
    await checks.nth(index).click();
    await expect(checks.nth(index)).toBeChecked();
  }
  await pack.getByLabel('Items counted for order 101').fill('3');
  await pack.getByRole('button', { name: 'Seal bag', exact: true }).click();
  const sealed = page.getByRole('dialog', { name: 'Bag sealed', exact: true });
  await expect(sealed.getByLabel('Shelf slot S1', { exact: true })).toBeVisible();
  await sealed.getByRole('button', { name: 'Done', exact: true }).click();
  await view(page, 'Pickup');
  await page.getByLabel('Enter the pickup code').fill('ZZ9');
  await expect(page.getByText('No matching order, check the app.', { exact: true })).toBeVisible();
  await page.getByLabel('Enter the pickup code').fill('A101');
  await expect(page.getByText('Order #101 is on shelf S1.')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm handoff', exact: true }).click();
  await expect(page.getByRole('listitem', { name: 'S1: free', exact: true })).toBeVisible();
});

test('number shortcut requests a manager override', async ({ page }) => {
  const order = await releasedBurger(page);
  await page.goto('/#stations');
  await page.getByRole('tab', { name: /^Grill/ }).click();
  const card = page.getByRole('article', { name: `Burger for order ${order.number}`, exact: true });
  await expect(card).toBeVisible();
  await page.keyboard.press('1');
  await expect(card.getByRole('group', { name: 'Manager override' })).toContainText('Not ready yet');
});

test('Rush Recovery simulates equipment loss without changing live orders', async ({ page }) => {
  await page.goto('/');
  const before = await state(page);
  expect(before.orders.filter((o) => o.status === 'RELEASED' && o.channel === 'delivery')).toHaveLength(1);
  await page.getByRole('button', { name: 'Rush Recovery', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rush Recovery', exact: true });
  await dialog.getByRole('button', { name: 'Equipment down', exact: true }).click();
  const simulated = page.waitForResponse(async (response) => {
    if (!response.url().endsWith('/api/simulate') || response.request().method() !== 'POST') return false;
    const data = response.request().postDataJSON();
    return data.changes?.[0]?.kind === 'equipment' && data.changes[0].resource === 'Grill';
  });
  await dialog.getByRole('button', { name: 'Grill', exact: true }).click();
  const response = await simulated;
  expect(response.ok()).toBeTruthy();
  const { simulation } = await response.json();
  expect(simulation.summary).toBeTruthy();
  await expect(dialog.getByText(simulation.summary, { exact: true })).toBeVisible();
  const after = await state(page);
  expect(recordedOrders(after)).toEqual(recordedOrders(before));
  expect(after.rev).toBe(before.rev);
  expect(after.stations.map((s) => s.outage)).toEqual(before.stations.map((s) => s.outage));
  await dialog.getByRole('button', { name: 'Cancel, keep the current plan', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('AI changes require explicit approval', async ({ page }) => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      calls++;
      const message = calls === 1
        ? { role: 'assistant', content: null, tool_calls: [{
            id: 'call_fryer', type: 'function', function: {
              name: 'propose_changes',
              arguments: JSON.stringify({ changes: [{ kind: 'equipment', resource: 'Fryer', units: 1, minutes: 10 }] }),
            },
          }] }
        : { role: 'assistant', content: 'Ready for your approval.' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `chatcmpl-test-${calls}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: 'test-model',
        choices: [{ index: 0, message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(3199, '127.0.0.1', resolve);
    });
    await page.goto('/');
    const before = await state(page);
    await page.getByRole('button', { name: 'Ask Praxis', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Ask Praxis', exact: true });
    await dialog.getByLabel('Your question').fill('Take one Fryer unit out of action for ten minutes.');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog.getByText('Ready for your approval.', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(dialog).toContainText('Fryer');
    expect(calls).toBe(2);
    const pending = await state(page);
    expect(pending.rev).toBe(before.rev);
    expect(recordedOrders(pending)).toEqual(recordedOrders(before));
    expect(pending.stations.map((s) => s.outage)).toEqual(before.stations.map((s) => s.outage));
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(dialog.getByText('Applied. Drafts were replanned.', { exact: true })).toBeVisible();
    const approved = await state(page);
    const outage = approved.stations.find((s) => s.name === 'Fryer')?.outage;
    expect(outage?.unitsOut).toBe(1);
    expect(outage!.untilMs - approved.serverNow).toBeGreaterThan(9 * 60_000);
    expect(outage!.untilMs - approved.serverNow).toBeLessThanOrEqual(10 * 60_000);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

test('tablet and phone layouts fit the viewport', async ({ page }) => {
  for (const [name, width, height] of [['tablet', 1024, 768], ['phone', 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await expect(page.getByRole('timer', { name: /^Restaurant time/ })).toBeVisible();
    for (const tab of ['Orders', 'Stations', 'Packing', 'Pickup']) {
      await view(page, tab);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await view(page, 'Orders');
    const choices = page.getByRole('button', { name: /^Select order/ });
    const lastChoice = choices.last();
    const choiceLabel = await lastChoice.getAttribute('aria-label');
    await lastChoice.click();
    await expect(page.getByRole('article', { name: choiceLabel!.replace('Select order', 'Order'), exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/praxis-${name}.png`, fullPage: true });
  }
});

test('API rejects invalid and cross-site mutations', async ({ page }) => {
  const invalid = await page.request.post('/api/orders', { data: {} });
  expect([400, 422]).toContain(invalid.status());
  const pickup = await page.request.post('/api/pickup', { data: { code: 'NOPE' } });
  expect(pickup.ok()).toBeTruthy();
  expect((await pickup.json()).lookup.match).toBe(false);
  const before = await state(page);
  const crossSite = await page.request.post('/api/orders', {
    headers: { origin: 'https://evil.example' },
    data: { channel: 'delivery', etaMinutes: 20, items: [{ recipe: 'burger', qty: 1 }] },
  });
  expect(crossSite.status()).toBe(403);
  expect(recordedOrders(await state(page))).toEqual(recordedOrders(before));
  const assistant = await page.request.post('/api/assistant', { data: { messages: [] } });
  expect(assistant.status()).toBe(400);
});

test('Start records cooking when the secure-context UUID API is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  });
  const order = await releasedBurger(page);
  await page.goto('/#stations');
  await view(page, 'Stations');
  await page.getByRole('tab', { name: /^Grill/ }).click();
  const card = page.getByRole('article', { name: `Burger for order ${order.number}`, exact: true });
  const response = page.waitForResponse(r => r.url().includes('/api/tasks/') && r.request().method() === 'POST');
  await card.getByRole('button', { name: `Start Burger for order ${order.number}`, exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(card.getByRole('timer')).toContainText('left');
  await expect(card.getByRole('button', { name: /^Start / })).toHaveCount(0);
  const saved = (await state(page)).orders.find(o => o.id === order.orderId)!;
  expect(saved.tasks.find(t => t.name === 'Grill burger')?.status).toBe('COOKING');
  expect(saved.tasks.find(t => t.name === 'Grill burger')?.actualStartMs).not.toBeNull();
});
