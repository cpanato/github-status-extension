export type Health =
  | "operational"
  | "maintenance"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "unknown";
export type ErrorKind =
  | "network"
  | "timeout"
  | "permission"
  | "invalid_response"
  | "http_error";
export interface Source {
  id: string;
  provider: "github-statuspage";
  label: string;
  baseUrl: string;
  checkKind: "published_status";
}
export const github: Source = {
  id: "github",
  provider: "github-statuspage",
  label: "GitHub",
  baseUrl: "https://www.githubstatus.com",
  checkKind: "published_status",
};
export interface Component {
  id: string;
  name: string;
  state: Health;
}
export interface Incident {
  id: string;
  title: string;
  state: string;
  severity: Health;
  url?: string;
  updatedAt?: string;
}
export interface Snapshot {
  sourceId: string;
  checkKind: "published_status";
  overall: Health;
  summary: string;
  components: Component[];
  incidents: Incident[];
  maintenance: Incident[];
  fetchedAt: number;
  expiresAt: number;
}
export interface Cache {
  snapshot?: Snapshot;
  checkedAt?: number;
  lastFailure?: number;
  error?: ErrorKind;
  failures: number;
  nextAttemptAt: number;
}
export interface Settings {
  theme: "system" | "light" | "dark";
  intervalMinutes: number;
}
export const defaults: Settings = { theme: "system", intervalMinutes: 1 };
export const labels: Record<Health, string> = {
  operational: "Operational",
  maintenance: "Maintenance",
  degraded: "Degraded Performance",
  partial_outage: "Partial Outage",
  major_outage: "Major Outage",
  unknown: "Status Unavailable",
};
export const rank: Record<Health, number> = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: -1,
};
export const colors: Record<Health, string> = {
  operational: "#238636",
  maintenance: "#8250df",
  degraded: "#9a6700",
  partial_outage: "#9a6700",
  major_outage: "#cf222e",
  unknown: "#6e7781",
};
export function worst(states: Health[]): Health {
  return states.reduce<Health>(
    (a, b) => (rank[b] > rank[a] ? b : a),
    "unknown",
  );
}
export function stale(cache: Cache, now = Date.now()): boolean {
  return !cache.snapshot || !!cache.error || cache.snapshot.expiresAt <= now;
}
export function toolbar(cache: Cache, now = Date.now()) {
  const state = stale(cache, now) ? "unknown" : cache.snapshot!.overall;
  return {
    state,
    color: colors[state],
    text: state === "operational" ? "✓" : state === "unknown" ? "?" : "!",
    title: `GitHub: ${labels[state]}${cache.snapshot && stale(cache, now) ? " · last known: " + labels[cache.snapshot.overall] : ""}`,
  };
}
export function settingsFrom(value: unknown): Settings {
  const v = value as Partial<Settings> | undefined;
  return {
    theme:
      v && ["system", "light", "dark"].includes(v.theme ?? "")
        ? v.theme!
        : "system",
    intervalMinutes:
      v && [1, 2, 5, 10].includes(v.intervalMinutes ?? 0)
        ? v.intervalMinutes!
        : 1,
  };
}
