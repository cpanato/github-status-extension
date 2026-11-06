import { test } from "node:test";
import assert from "node:assert/strict";
import { toolbar, stale, settingsFrom, defaults } from "../src/domain.js";
import {
  normalize,
  componentState,
  indicatorState,
  safeLink,
  ProviderError,
  githubProvider,
} from "../src/providers/github.js";
import { github } from "../src/domain.js";
import { emptyCache } from "../src/storage.js";
import { fetchCache, retryDelay } from "../src/background/polling.js";
import { summary } from "./fixtures.js";

test("maps every component and rollup status, including unknown enums", () => {
  for (const [input, expected] of Object.entries({
    operational: "operational",
    degraded_performance: "degraded",
    partial_outage: "partial_outage",
    major_outage: "major_outage",
    under_maintenance: "maintenance",
    future_value: "unknown",
  }))
    assert.equal(componentState(input), expected);
  for (const [input, expected] of Object.entries({
    none: "operational",
    minor: "degraded",
    major: "partial_outage",
    critical: "major_outage",
    maintenance: "maintenance",
    new_value: "unknown",
  }))
    assert.equal(indicatorState(input), expected);
});
test("uses worst known issue and sorts affected components first", () => {
  const value = summary("major_outage", "minor");
  value.components.reverse();
  const snapshot = normalize(value);
  assert.equal(snapshot.overall, "major_outage");
  assert.equal(snapshot.components[0]?.id, "api");
});
test("unknown values cannot produce a healthy rollup", () => {
  assert.equal(normalize(summary("new_value")).overall, "unknown");
  assert.equal(
    normalize(summary("operational", "new_value")).overall,
    "unknown",
  );
});
test("invalid or empty payload cannot erase good data", () => {
  for (const input of [
    null,
    {},
    { ...summary(), components: [] },
    { ...summary(), incidents: "bad" },
    { ...summary(), components: Array(201).fill({}) },
  ])
    assert.throws(() => normalize(input), ProviderError);
});
test("links allow only trusted HTTPS destinations without credentials", () => {
  for (const bad of [
    "javascript:alert(1)",
    "https://evil.test/a",
    "https://www.githubstatus.com.evil.test/",
    "http://www.githubstatus.com/",
    "https://u:p@www.githubstatus.com/",
    "https://stspg.io:8080/a",
  ])
    assert.equal(safeLink(bad), undefined);
  assert.equal(safeLink("https://stspg.io/abcd"), "https://stspg.io/abcd");
});
test("maintenance is separate from incidents and upcoming work is not an outage", () => {
  const value = {
    ...summary(),
    scheduled_maintenances: [
      {
        id: "m",
        name: "Scheduled work",
        status: "scheduled",
        impact: "maintenance",
      },
    ],
  };
  assert.equal(normalize(value).overall, "operational");
  value.scheduled_maintenances[0]!.status = "in_progress";
  const result = normalize(value);
  assert.equal(result.overall, "maintenance");
  assert.equal(result.maintenance.length, 1);
  assert.equal(result.incidents.length, 0);
});
test("incident severity contributes to rollup and unsafe links are dropped", () => {
  const value = {
    ...summary(),
    incidents: [
      {
        id: "one",
        name: "<img onerror=alert(1)>",
        status: "investigating",
        impact: "critical",
        shortlink: "javascript:alert(1)",
      },
    ],
  };
  const snapshot = normalize(value);
  assert.equal(snapshot.overall, "major_outage");
  assert.equal(snapshot.incidents[0]?.url, undefined);
});
test("toolbar becomes unknown on expired or failed checks", () => {
  const snapshot = normalize(summary(), 1000);
  const cache = { ...emptyCache(), snapshot };
  assert.equal(toolbar(cache, 1001).state, "operational");
  assert.equal(stale(cache, 61_000), true);
  assert.equal(toolbar(cache, 61_000).state, "unknown");
  assert.equal(toolbar({ ...cache, error: "network" }, 1001).state, "unknown");
  assert.equal(toolbar(emptyCache()).state, "unknown");
  assert.equal(
    toolbar(
      { ...cache, snapshot: normalize(summary("degraded_performance"), 1000) },
      1001,
    ).state,
    "degraded",
  );
});
test("backoff grows conservatively, bounds jitter and honors Retry-After", () => {
  assert.equal(retryDelay(1, 1, 0, 0), 120_000);
  assert.equal(retryDelay(2, 1, 0, 0), 240_000);
  assert.equal(retryDelay(100, 10, 0, 0), 3_600_000);
  assert.equal(retryDelay(1, 1, 900_000, 0), 900_000);
});
test("poller preserves last successful snapshot and resets error on recovery", async () => {
  const snapshot = normalize(summary());
  const cache = { ...emptyCache(), snapshot };
  const failed = await fetchCache(cache, defaults, {
    id: "github-statuspage",
    async fetchStatus() {
      throw new ProviderError("http_error", 900_000);
    },
  });
  assert.equal(failed.snapshot, snapshot);
  assert.equal(failed.error, "http_error");
  assert.equal(failed.failures, 1);
  assert.ok(failed.nextAttemptAt >= Date.now() + 899_000);
  const recovered = await fetchCache(failed, defaults, {
    id: "github-statuspage",
    async fetchStatus() {
      return snapshot;
    },
  });
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.failures, 0);
});
test("settings reject invalid intervals and themes", () => {
  assert.deepEqual(
    settingsFrom({ theme: "bad", intervalMinutes: 0 }),
    defaults,
  );
  assert.deepEqual(settingsFrom({ theme: "dark", intervalMinutes: 5 }), {
    theme: "dark",
    intervalMinutes: 5,
  });
});
test("HTTP adapter rejects HTTP errors, content types, oversize and malformed JSON", async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      new Response("{}", { status: 500 }),
      new Response("oops", { headers: { "content-type": "text/html" } }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      new Response("x".repeat(1_048_577), {
        headers: { "content-type": "application/json" },
      }),
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(
        githubProvider.fetchStatus(github, new AbortController().signal, 1),
        ProviderError,
      );
    }
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      return Response.json(summary());
    };
    assert.equal(
      (
        await githubProvider.fetchStatus(
          github,
          new AbortController().signal,
          5,
        )
      ).overall,
      "operational",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("transport and abort failures are classified without losing cache", async () => {
  const failed = await fetchCache(emptyCache(), defaults, {
    id: "github-statuspage",
    async fetchStatus() {
      throw new TypeError("offline");
    },
  });
  assert.equal(failed.error, "network");
});

test("timeout aborts the request and retains cached data", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const snapshot = normalize(summary());
  const pending = fetchCache({ ...emptyCache(), snapshot }, defaults, {
    id: "github-statuspage",
    async fetchStatus(_source, signal) {
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  t.mock.timers.tick(10_001);
  const result = await pending;
  assert.equal(result.error, "timeout");
  assert.equal(result.snapshot, snapshot);
});

test("permission denial remains explicit in cache and toolbar", async () => {
  const result = await fetchCache(emptyCache(), defaults, {
    id: "github-statuspage",
    async fetchStatus() {
      throw new ProviderError("permission");
    },
  });
  assert.equal(result.error, "permission");
  assert.equal(toolbar(result).state, "unknown");
});
