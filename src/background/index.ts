import {
  toolbar,
  stale,
  github,
  refreshAllowedAt,
  type Cache,
  type RefreshResult,
} from "../domain.js";
import {
  providers,
  ProviderError,
  type StatusProvider,
} from "../providers/github.js";
import { emptyCache, readCache, readSettings } from "../storage.js";
import { fetchCache } from "./polling.js";
const alarmName = "github-refresh";
let inFlight: Promise<RefreshResult> | undefined;
const authorizedProvider: StatusProvider = {
  id: "github-statuspage",
  async fetchStatus(source, signal, interval) {
    if (
      !(await chrome.permissions.contains({ origins: [`${github.baseUrl}/*`] }))
    )
      throw new ProviderError("permission");
    return providers["github-statuspage"].fetchStatus(source, signal, interval);
  },
};
async function updateToolbar(cache: Cache) {
  const state = toolbar(cache);
  await Promise.all([
    chrome.action.setIcon({ path: state.icon }),
    chrome.action.setTitle({ title: state.title }),
    chrome.action.setBadgeText({
      text: state.state === "operational" ? "" : state.text,
    }),
    chrome.action.setBadgeBackgroundColor({ color: state.color }),
  ]);
}
async function schedule(cache: Cache) {
  // The recurring alarm is a safety net if the worker stops between fetch and rescheduling.
  await chrome.alarms.create(alarmName, {
    when: Math.max(
      Date.now() + 30_000,
      Math.min(
        cache.nextAttemptAt || Date.now(),
        cache.snapshot?.expiresAt && !stale(cache)
          ? cache.snapshot.expiresAt
          : Infinity,
      ),
    ),
    periodInMinutes: 1,
  });
}
function refresh(manual = false): Promise<RefreshResult> {
  if (inFlight) {
    return manual
      ? inFlight.then((result) => {
          // A manual click may arrive while an automatic cache check is finishing.
          // Join a real request, but start one if that check only returned the cache.
          return result.outcome === "deferred" &&
            Date.now() >= refreshAllowedAt(result.cache, true)
            ? refresh(true)
            : result;
        })
      : inFlight;
  }
  inFlight = (async (): Promise<RefreshResult> => {
    const [cache, settings] = await Promise.all([readCache(), readSettings()]);
    await updateToolbar(cache);
    if (Date.now() < refreshAllowedAt(cache, manual)) {
      await schedule(cache);
      return { cache, outcome: "deferred" };
    }
    const next = await fetchCache(cache, settings, authorizedProvider);
    await chrome.storage.local.set({ cache: next });
    await updateToolbar(next);
    await schedule(next);
    return { cache: next, outcome: next.error ? "failed" : "updated" };
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
function run() {
  void refresh().catch(() => {
    void updateToolbar(emptyCache()).catch(() => {});
  });
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName) run();
});
chrome.runtime.onInstalled.addListener(run);
chrome.runtime.onStartup.addListener(run);
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    !message ||
    typeof message !== "object" ||
    !("type" in message)
  )
    return false;
  if (message.type === "refresh") {
    refresh("manual" in message && message.manual === true)
      .then((result) => reply(result))
      .catch(() => reply({ error: "storage" }));
    return true;
  }
  if (message.type === "settings-updated") {
    // Serialize with any existing fetch so that a changed TTL is applied to the next request.
    (async () => {
      if (inFlight) await inFlight;
      const cache = await readCache();
      if (!cache.error) {
        cache.nextAttemptAt = 0;
        await chrome.storage.local.set({ cache });
      }
      return refresh();
    })()
      .then(() => reply({ ok: true }))
      .catch(() => reply({ error: "storage" }));
    return true;
  }
  return false;
});
// Listeners are registered synchronously, then alarms are restored on every worker start.
void (async () => {
  if (!(await chrome.alarms.get(alarmName)))
    await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  run();
})().catch(() => {
  void updateToolbar(emptyCache()).catch(() => {});
});
