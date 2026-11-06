import { labels, stale, type Cache, type Incident } from "../domain.js";
import { safeLink } from "../providers/github.js";
import { readCache, readSettings } from "../storage.js";
import { applyTheme, element, get, time } from "./shared.js";
let current: Cache | undefined;
const refreshButton = get<HTMLButtonElement>("refresh");
function incidents(id: string, values: Incident[], empty: string) {
  const parent = get(id);
  parent.replaceChildren();
  if (!values.length) {
    parent.append(element("p", empty, "empty"));
    return;
  }
  for (const item of values) {
    const card = element("article", undefined, `incident ${item.severity}`);
    const link = safeLink(item.url);
    const title = element("h3");
    if (link) {
      const a = element("a", item.title);
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      title.append(a);
    } else title.textContent = item.title;
    card.append(
      title,
      element(
        "p",
        `${labels[item.severity]} · ${item.state.replaceAll("_", " ")}${item.updatedAt ? " · " + time(Date.parse(item.updatedAt)) : ""}`,
        "muted",
      ),
    );
    parent.append(card);
  }
}
function render(cache: Cache) {
  current = cache;
  const snapshot = cache.snapshot;
  const isStale = stale(cache);
  const state = isStale ? "unknown" : snapshot!.overall;
  get("hero").className = `hero ${state}`;
  get("hero-icon").textContent =
    state === "operational" ? "✓" : state === "unknown" ? "?" : "!";
  get("summary").textContent =
    snapshot && !isStale ? snapshot.summary : "Status Unavailable";
  get("hero-detail").textContent = snapshot
    ? isStale
      ? `Last known: ${snapshot.summary}`
      : "Published status from GitHub"
    : "Waiting for a successful check";
  const notice = get("notice");
  notice.hidden = !isStale;
  notice.textContent = cache.error
    ? `Could not update status (${cache.error.replaceAll("_", " ")}). ${snapshot ? "Showing cached data; it may be out of date." : "Check your connection or extension site permissions."}`
    : snapshot
      ? "Cached data is out of date. Checking for an update."
      : "No status data yet. Try refreshing.";
  const list = get("components");
  list.replaceChildren();
  for (const c of snapshot?.components ?? []) {
    const row = element("li");
    row.append(
      element("span", c.name, "component-name"),
      element("span", labels[c.state], `badge ${c.state}`),
    );
    list.append(row);
  }
  get("component-count").textContent = snapshot
    ? `${snapshot.components.length}${isStale ? " · cached" : ""}`
    : "—";
  get("incident-count").textContent = snapshot
    ? `${snapshot.incidents.length}${isStale ? " · cached" : ""}`
    : "—";
  incidents(
    "incidents",
    snapshot?.incidents ?? [],
    snapshot
      ? isStale
        ? "No active incidents in cached data."
        : "No active incidents. All quiet here."
      : "Incident data unavailable.",
  );
  get("maintenance-section").hidden = !snapshot?.maintenance.length;
  incidents("maintenance", snapshot?.maintenance ?? [], "");
  get("updated").textContent = snapshot
    ? `Updated ${time(snapshot.fetchedAt)}${isStale ? " · stale" : ""}`
    : "No successful checks yet";
  get("updated").title = snapshot
    ? new Date(snapshot.fetchedAt).toLocaleString()
    : "";
  const wait = Math.max(0, (cache.nextAttemptAt - Date.now()) / 1000);
  refreshButton.title =
    wait > 0
      ? `Next API check in about ${Math.ceil(wait)} seconds`
      : "Check GitHub Status";
}
async function refresh() {
  refreshButton.disabled = true;
  refreshButton.textContent = "↻ Checking…";
  try {
    const result = (await chrome.runtime.sendMessage({ type: "refresh" })) as {
      cache?: Cache;
      error?: string;
    };
    if (result.cache) render(result.cache);
    else throw new Error("unavailable");
  } catch {
    const notice = get("notice");
    notice.hidden = false;
    notice.textContent =
      "Background check unavailable. Reload the extension and try again.";
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "↻ Refresh";
  }
}
refreshButton.addEventListener("click", () => {
  void refresh();
});
get("settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.cache) render(changes.cache.newValue as Cache);
  if (changes.settings) void readSettings().then(applyTheme);
});
// This timer only updates freshness while the popup is open; background polling uses alarms.
setInterval(() => {
  if (current) {
    render(current);
    if (stale(current) && Date.now() >= current.nextAttemptAt) void refresh();
  }
}, 15_000);
void (async () => {
  applyTheme(await readSettings());
  const cache = await readCache();
  render(cache);
  if (stale(cache)) await refresh();
})().catch(() => {
  get("summary").textContent = "Status Unavailable";
  get("hero-detail").textContent =
    "Local storage could not be read. Reload the extension.";
});
