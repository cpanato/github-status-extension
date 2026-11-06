import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { summary } from "../fixtures.js";
let context: BrowserContext;
let worker: Worker;
let extensionId: string;
let profile: string;
test.beforeAll(async () => {
  profile = await mkdtemp(path.join(tmpdir(), "github-status-e2e-"));
  const extension = path.resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).hostname;
  // Stub only the external API inside the real MV3 worker. All messaging, storage,
  // alarms, toolbar APIs, rendering and extension permissions remain real.
  await expect
    .poll(
      () =>
        worker.evaluate(async () =>
          typeof chrome !== "undefined" && chrome.storage
            ? (await chrome.storage.local.get("cache")).cache?.checkedAt
            : undefined,
        ),
      { timeout: 15_000 },
    )
    .toBeTruthy();
});
test.afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
async function seed(state = "operational", indicator = "none") {
  await worker.evaluate(
    async (payload) => {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });
      await chrome.storage.local.set({
        cache: { failures: 0, nextAttemptAt: 0 },
      });
    },
    summary(state, indicator),
  );
  await requestRefresh();
}
async function requestRefresh() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "refresh" }));
  await page.close();
}
test("fresh popup, real toolbar, alarms and minimal permissions", async () => {
  await seed();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(
    page.getByRole("heading", { name: "All Systems Operational" }),
  ).toBeVisible();
  await expect(page.locator("#components li")).toHaveCount(2);
  await expect(
    page.getByText("No active incidents. All quiet here."),
  ).toBeVisible();
  const result = await worker.evaluate(async () => ({
    title: await chrome.action.getTitle({}),
    badge: await chrome.action.getBadgeText({}),
    alarm: await chrome.alarms.get("github-refresh"),
    permissions: chrome.runtime.getManifest().permissions,
    hosts: chrome.runtime.getManifest().host_permissions,
  }));
  expect(result.title).toContain("Operational");
  expect(result.badge).toBe("");
  expect(result.alarm).toBeTruthy();
  expect(result.permissions).toEqual(["storage", "alarms"]);
  expect(result.hosts).toEqual(["https://www.githubstatus.com/*"]);
  await page.screenshot({ path: "test-results/popup-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: "test-results/popup-dark.png" });
  await page.close();
});
test("degraded and outage status update the popup and toolbar", async () => {
  for (const [state, expected] of [
    ["degraded_performance", "Degraded Performance"],
    ["major_outage", "Major Outage"],
  ]) {
    await seed(state);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator("#summary")).toHaveText(expected!);
    expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe(
      "!",
    );
    await page.close();
  }
});
test("failed request retains cached rows and marks toolbar unknown", async () => {
  await seed();
  await worker.evaluate(async () => {
    globalThis.fetch = async () => {
      throw new TypeError("offline");
    };
    const { cache } = await chrome.storage.local.get("cache");
    cache.nextAttemptAt = 0;
    await chrome.storage.local.set({ cache });
  });
  await requestRefresh();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("#summary")).toHaveText("Status Unavailable");
  await expect(page.locator("#notice")).toContainText("network");
  await expect(page.locator("#components li")).toHaveCount(2);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("?");
  await page.close();
});
test("remote incident text is inert and unsafe links are omitted", async () => {
  await worker.evaluate(async (payload) => {
    globalThis.fetch = async () =>
      Response.json({
        ...payload,
        incidents: [
          {
            id: "x",
            name: "<img src=x onerror=alert(1)>",
            status: "investigating",
            impact: "major",
            shortlink: "javascript:alert(1)",
          },
        ],
      });
    await chrome.storage.local.set({
      cache: { failures: 0, nextAttemptAt: 0 },
    });
  }, summary());
  await requestRefresh();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("#incidents h3")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator("#incidents img, #incidents a")).toHaveCount(0);
  await page.close();
});
test("settings persist theme and interval through page reload", async () => {
  await seed();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.getByLabel("Appearance").selectOption("dark");
  await page.getByLabel("Check for updates").selectOption("5");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved.");
  await page.reload();
  await expect(page.getByLabel("Appearance")).toHaveValue("dark");
  await expect(page.getByLabel("Check for updates")).toHaveValue("5");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.close();
});

test("expired cache is marked unknown even during a deferred refresh", async () => {
  await seed();
  await worker.evaluate(async () => {
    const { cache } = await chrome.storage.local.get("cache");
    cache.snapshot.expiresAt = Date.now() - 1000;
    cache.nextAttemptAt = Date.now() + 60_000;
    await chrome.storage.local.set({ cache });
  });
  await requestRefresh();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator("#summary")).toHaveText("Status Unavailable");
  await expect(page.locator("#component-count")).toContainText("cached");
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe("?");
  await page.close();
});
