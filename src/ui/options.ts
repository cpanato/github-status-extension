import { settingsFrom, type Cache } from "../domain.js";
import { readSettings, readCache } from "../storage.js";
import { applyTheme, element, get } from "./shared.js";
const theme = get<HTMLSelectElement>("theme");
const interval = get<HTMLSelectElement>("interval");
function diagnostics(cache: Cache) {
  const dl = get("diagnostics");
  dl.replaceChildren();
  const date = (v?: number) => (v ? new Date(v).toLocaleString() : "Never");
  for (const [key, value] of Object.entries({
    "Last success": date(cache.snapshot?.fetchedAt),
    "Last check": date(cache.checkedAt),
    "Last failure": date(cache.lastFailure),
    "Current error": cache.error ?? "None",
    "Cache age": cache.snapshot
      ? `${Math.floor((Date.now() - cache.snapshot.fetchedAt) / 60_000)} minutes`
      : "No data",
    "Next check": date(cache.nextAttemptAt),
  }))
    dl.append(element("dt", key), element("dd", value));
}
get<HTMLFormElement>("preferences").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const settings = settingsFrom({
      theme: theme.value,
      intervalMinutes: Number(interval.value),
    });
    await chrome.storage.local.set({ settings });
    applyTheme(settings);
    await chrome.runtime.sendMessage({ type: "settings-updated" });
    get("saved").textContent = "Settings saved.";
  })().catch(() => {
    get("saved").textContent = "Could not save settings. Please try again.";
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cache)
    diagnostics(changes.cache.newValue as Cache);
});
void (async () => {
  const settings = await readSettings();
  applyTheme(settings);
  theme.value = settings.theme;
  interval.value = String(settings.intervalMinutes);
  diagnostics(await readCache());
})().catch(() => {
  get("saved").textContent = "Could not read local settings.";
});
