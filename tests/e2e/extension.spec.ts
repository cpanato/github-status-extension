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
  await worker.evaluate(() => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    Object.assign(globalThis, { statusFetch: nativeFetch });
    globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith("https://www.githubstatus.com/")
        ? Reflect.get(globalThis, "statusFetch")(input, init)
        : nativeFetch(input, init);
    };
  });
});
test.afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});
async function seed(state = "operational", indicator = "none") {
  await worker.evaluate(
    async (payload) => {
      Object.assign(globalThis, {
        statusFetch: async () =>
          new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          }),
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
  await page
    .locator("body")
    .screenshot({ path: "test-results/popup-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page
    .locator("body")
    .screenshot({ path: "test-results/popup-dark.png" });
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
    Object.assign(globalThis, {
      statusFetch: async () => {
        throw new TypeError("offline");
      },
    });
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
    Object.assign(globalThis, {
      statusFetch: async () =>
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
        }),
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

test("Chrome Extensions displays the packaged status icon", async () => {
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  const icon = page
    .locator(`extensions-item[id="${extensionId}"]`)
    .locator("img#icon");
  await expect(icon).toBeVisible();
  await expect
    .poll(() =>
      icon.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/chrome-extensions-icon.png" });
  await page.close();
});

test("toolbar installs the correct colored status PNGs for every health category", async () => {
  await worker.evaluate(() => {
    const original = chrome.action.setIcon.bind(chrome.action);
    chrome.action.setIcon = async (details) => {
      Object.assign(chrome.action, { lastIcon: details.path });
      await original(details);
    };
  });
  for (const [state, variant, rgb] of [
    ["operational", "operational", [35, 134, 54]],
    ["degraded_performance", "attention", [191, 135, 0]],
    ["under_maintenance", "attention", [191, 135, 0]],
    ["partial_outage", "outage", [207, 34, 46]],
    ["major_outage", "outage", [207, 34, 46]],
    ["unrecognized", "unknown", [110, 119, 129]],
  ] as const) {
    await seed(state);
    const icon = await worker.evaluate(() =>
      Reflect.get(chrome.action, "lastIcon"),
    );
    expect(icon).toEqual({
      16: `/icons/${variant}-16.png`,
      24: `/icons/${variant}-24.png`,
      32: `/icons/${variant}-32.png`,
    });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const image = await page.evaluate(async (name) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`icons/${name}-32.png`)).blob(),
      );
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        edge: Array.from(ctx.getImageData(0, 0, 1, 1).data),
        ring: Array.from(ctx.getImageData(16, 3, 1, 1).data),
        center: Array.from(ctx.getImageData(16, 16, 1, 1).data),
      };
    }, variant);
    expect(image.edge[3]).toBe(0);
    expect(image.center).toEqual([...rgb, 255]);
    expect(image.ring[3]).toBe(0);
    await page.close();
  }
});

test("manual refresh fetches immediately for fresh cache and on consecutive clicks", async () => {
  await seed();
  const before = await worker.evaluate(async () => {
    const { cache } = await chrome.storage.local.get("cache");
    const original = Reflect.get(globalThis, "statusFetch");
    Object.assign(globalThis, {
      manualFetchCount: 0,
      statusFetch: (...args: unknown[]) => {
        Reflect.set(
          globalThis,
          "manualFetchCount",
          Reflect.get(globalThis, "manualFetchCount") + 1,
        );
        return original(...args);
      },
    });
    cache.snapshot.fetchedAt = Date.now() - 2000;
    await chrome.storage.local.set({ cache });
    return cache.snapshot.fetchedAt as number;
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const button = page.getByRole("button", { name: "↻ Refresh", exact: true });
  await button.click();
  await expect(page.locator("#refresh-feedback")).toContainText(
    "Status refreshed at",
  );
  await expect(page.locator("#updated")).toContainText(/\d{1,2}:\d{2}:\d{2}/);
  const first = await worker.evaluate(
    async () => (await chrome.storage.local.get("cache")).cache,
  );
  expect(first.snapshot.fetchedAt).toBeGreaterThan(before);
  expect(first.nextAttemptAt).toBeGreaterThan(Date.now());
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
  await expect
    .poll(() =>
      worker.evaluate(() => Reflect.get(globalThis, "manualFetchCount")),
    )
    .toBe(2);
  await page.close();
});

test("a failed manual refresh shows failure and can retry immediately after network recovery", async () => {
  await seed();
  await worker.evaluate(() => {
    Object.assign(globalThis, {
      statusFetch: async () => {
        throw new TypeError("offline");
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const previousTime = await page.locator("#updated").textContent();
  const button = page.getByRole("button", { name: "↻ Refresh", exact: true });
  await button.click();
  await expect(page.locator("#refresh-feedback")).toContainText(
    "Refresh failed",
  );
  await expect(page.locator("#updated")).toHaveText(`${previousTime} · stale`);
  await expect(button).toBeEnabled();
  await worker.evaluate((payload) => {
    Object.assign(globalThis, {
      statusFetch: async () => Response.json(payload),
    });
  }, summary());
  await button.click();
  await expect(page.locator("#refresh-feedback")).toContainText(
    "Status refreshed at",
  );
  await expect(page.locator("#notice")).toBeHidden();
  await page.close();
});

test("provider Retry-After is explicit and concurrent manual requests share one fetch", async () => {
  await seed();
  await worker.evaluate(() => {
    Object.assign(globalThis, {
      manualFetchCount: 0,
      statusFetch: async () => {
        Reflect.set(
          globalThis,
          "manualFetchCount",
          Reflect.get(globalThis, "manualFetchCount") + 1,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response("{}", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const results = await page.evaluate(() =>
    Promise.all([
      chrome.runtime.sendMessage({ type: "refresh", manual: true }),
      chrome.runtime.sendMessage({ type: "refresh", manual: true }),
    ]),
  );
  expect(results.map((result) => result.outcome)).toEqual(["failed", "failed"]);
  expect(
    await worker.evaluate(() => Reflect.get(globalThis, "manualFetchCount")),
  ).toBe(1);
  await expect(page.locator("#refresh")).toBeDisabled();
  await expect(page.locator("#refresh")).toContainText("Retry in");
  await expect(page.locator("#refresh")).toHaveAttribute(
    "title",
    /GitHub requested a wait/,
  );
  const deferred = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: "refresh", manual: true }),
  );
  expect(deferred.outcome).toBe("deferred");
  expect(
    await worker.evaluate(() => Reflect.get(globalThis, "manualFetchCount")),
  ).toBe(1);
  await page.close();
});

test("manual refresh still fetches when it joins an automatic cache-only check", async () => {
  await seed();
  await worker.evaluate(() => {
    const original = Reflect.get(globalThis, "statusFetch");
    Object.assign(globalThis, {
      manualFetchCount: 0,
      statusFetch: (...args: unknown[]) => {
        Reflect.set(
          globalThis,
          "manualFetchCount",
          Reflect.get(globalThis, "manualFetchCount") + 1,
        );
        return original(...args);
      },
    });
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  const results = await page.evaluate(() =>
    Promise.all([
      chrome.runtime.sendMessage({ type: "refresh" }),
      chrome.runtime.sendMessage({ type: "refresh", manual: true }),
    ]),
  );
  expect(results.map((result) => result.outcome)).toEqual([
    "deferred",
    "updated",
  ]);
  expect(
    await worker.evaluate(() => Reflect.get(globalThis, "manualFetchCount")),
  ).toBe(1);
  await page.close();
});
