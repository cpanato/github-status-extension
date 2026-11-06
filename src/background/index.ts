import { toolbar, stale, github, type Cache } from "../domain.js";
import {
  providers,
  ProviderError,
  type StatusProvider,
} from "../providers/github.js";
import { emptyCache, readCache, readSettings } from "../storage.js";
import { fetchCache } from "./polling.js";
const alarmName = "github-refresh";
let inFlight: Promise<Cache> | undefined;
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
function refresh(): Promise<Cache> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const [cache, settings] = await Promise.all([readCache(), readSettings()]);
    await updateToolbar(cache);
    if (Date.now() < cache.nextAttemptAt) {
      await schedule(cache);
      return cache;
    }
    const next = await fetchCache(cache, settings, authorizedProvider);
    await chrome.storage.local.set({ cache: next });
    await updateToolbar(next);
    await schedule(next);
    return next;
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
    refresh()
      .then((cache) => reply({ cache }))
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
