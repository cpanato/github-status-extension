import {
  labels,
  stale,
  refreshAllowedAt,
  type Cache,
  type Incident,
  type RefreshResult,
} from "../domain.js";
import { safeLink } from "../providers/github.js";
import { emptyCache, readCache, readSettings } from "../storage.js";
import { applyTheme, element, get, time } from "./shared.js";
let current: Cache | undefined;
let refreshing = false;
const refreshButton = get<HTMLButtonElement>("refresh");
const refreshFeedback = get("refresh-feedback");
function renderRefreshControl(cache: Cache) {
  const wait = Math.max(
    0,
    Math.ceil((refreshAllowedAt(cache, true) - Date.now()) / 1000),
  );
  refreshButton.disabled = refreshing || wait > 0;
  refreshButton.textContent = refreshing
    ? "↻ Checking…"
    : wait > 0
      ? `↻ Retry in ${wait}s`
      : "↻ Refresh";
  refreshButton.title =
    wait > 0
      ? `GitHub requested a wait until ${time(refreshAllowedAt(cache, true), true)}`
      : "Fetch the latest GitHub Status now";
}
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
    ? `Updated ${time(snapshot.fetchedAt, true)}${isStale ? " · stale" : ""}`
    : "No successful checks yet";
  get("updated").title = snapshot
    ? new Date(snapshot.fetchedAt).toLocaleString()
    : "";
  renderRefreshControl(cache);
}
async function refresh(manual = false) {
  if (refreshing) return;
  refreshing = true;
  renderRefreshControl(current ?? emptyCache());
  if (manual) refreshFeedback.textContent = "Checking GitHub Status…";
  try {
    const result = (await chrome.runtime.sendMessage({
      type: "refresh",
      manual,
    })) as Partial<RefreshResult> & {
      error?: string;
    };
    if (!result.cache) throw new Error("unavailable");
    render(result.cache);
    if (manual) {
      if (result.outcome === "updated" && result.cache.snapshot) {
        refreshFeedback.textContent = `Status refreshed at ${time(result.cache.snapshot.fetchedAt, true)}.`;
      } else if (
        result.outcome === "deferred" ||
        (result.cache.retryAfterUntil ?? 0) > Date.now()
      ) {
        refreshFeedback.textContent = `GitHub requested a wait. Try again at ${time(refreshAllowedAt(result.cache, true), true)}.`;
      } else {
        refreshFeedback.textContent =
          "Refresh failed. The last successful update time is unchanged.";
      }
    }
  } catch {
    const notice = get("notice");
    notice.hidden = false;
    notice.textContent =
      "Background check unavailable. Reload the extension and try again.";
    if (manual)
      refreshFeedback.textContent =
        "Could not refresh status. Please try again.";
  } finally {
    refreshing = false;
    renderRefreshControl(current ?? emptyCache());
  }
}
refreshButton.addEventListener("click", () => {
  void refresh(true);
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
setInterval(() => {
  if (current) renderRefreshControl(current);
}, 1000);
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
