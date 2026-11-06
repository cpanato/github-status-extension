import {
  github,
  labels,
  rank,
  worst,
  type Health,
  type Snapshot,
  type Source,
  type Incident,
  type ErrorKind,
} from "../domain.js";
export interface StatusProvider {
  readonly id: Source["provider"];
  fetchStatus(
    source: Source,
    signal: AbortSignal,
    ttlMinutes: number,
  ): Promise<Snapshot>;
}
export class ProviderError extends Error {
  constructor(
    public kind: ErrorKind,
    public retryAfter = 0,
  ) {
    super(kind);
  }
}
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new ProviderError("invalid_response");
  return v as Record<string, unknown>;
};
const string = (v: unknown, max = 300): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new ProviderError("invalid_response");
  return v;
};
const list = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 200)
    throw new ProviderError("invalid_response");
  return v;
};
export function componentState(v: unknown): Health {
  switch (v) {
    case "operational":
      return "operational";
    case "degraded_performance":
      return "degraded";
    case "partial_outage":
      return "partial_outage";
    case "major_outage":
      return "major_outage";
    case "under_maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}
export function indicatorState(v: unknown): Health {
  switch (v) {
    case "none":
      return "operational";
    case "minor":
      return "degraded";
    case "major":
      return "partial_outage";
    case "critical":
      return "major_outage";
    case "maintenance":
      return "maintenance";
    default:
      return "unknown";
  }
}
export function safeLink(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const u = new URL(value);
    if (
      u.protocol === "https:" &&
      ["www.githubstatus.com", "stspg.io"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.port
    )
      return u.href;
  } catch {
    /* Untrusted provider link. */
  }
  return;
}
function incident(value: unknown, maintenance = false): Incident {
  const v = record(value);
  return {
    id: string(v.id),
    title: string(v.name),
    state: string(v.status),
    severity: maintenance
      ? "maintenance"
      : ((
          {
            none: "operational",
            minor: "degraded",
            major: "partial_outage",
            critical: "major_outage",
          } as Record<string, Health>
        )[String(v.impact)] ?? "unknown"),
    url: safeLink(v.shortlink),
    updatedAt:
      typeof v.updated_at === "string" &&
      Number.isFinite(Date.parse(v.updated_at))
        ? v.updated_at
        : undefined,
  };
}
export function normalize(
  value: unknown,
  now = Date.now(),
  ttlMinutes = 1,
): Snapshot {
  const v = record(value);
  const status = record(v.status);
  const components = list(v.components)
    .map((value) => {
      const c = record(value);
      return {
        id: string(c.id),
        name: string(c.name),
        state: componentState(c.status),
      };
    })
    .sort(
      (a, b) => rank[b.state] - rank[a.state] || a.name.localeCompare(b.name),
    );
  if (!components.length) throw new ProviderError("invalid_response");
  const incidents = list(v.incidents)
    .map((v) => incident(v))
    .sort((a, b) => rank[b.severity] - rank[a.severity]);
  const maintenance = list(v.scheduled_maintenances ?? []).map((v) =>
    incident(v, true),
  );
  const rollup = indicatorState(status.indicator);
  const known = worst([
    rollup,
    ...components.map((c) => c.state),
    ...incidents.map((i) => i.severity),
    ...maintenance
      .filter((m) => ["in_progress", "verifying"].includes(m.state))
      .map((m) => m.severity),
  ]);
  const incomplete =
    rollup === "unknown" ||
    components.some((c) => c.state === "unknown") ||
    incidents.some((i) => i.severity === "unknown");
  const overall = incomplete && rank[known] <= 0 ? "unknown" : known;
  return {
    sourceId: github.id,
    checkKind: "published_status",
    overall,
    summary:
      overall === "operational" ? "All Systems Operational" : labels[overall],
    components,
    incidents,
    maintenance,
    fetchedAt: now,
    expiresAt: now + ttlMinutes * 60_000,
  };
}
export const githubProvider: StatusProvider = {
  id: "github-statuspage",
  async fetchStatus(source, signal, ttlMinutes) {
    if (source.baseUrl !== github.baseUrl)
      throw new ProviderError("permission");
    const response = await fetch(`${source.baseUrl}/api/v2/summary.json`, {
      signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      const seconds =
        retry && /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry ?? "") - Date.now();
      throw new ProviderError(
        "http_error",
        Number.isFinite(seconds)
          ? Math.max(0, Math.min(seconds, 86_400_000))
          : 0,
      );
    }
    if (
      !response.headers.get("content-type")?.includes("application/json") ||
      !response.body
    )
      throw new ProviderError("invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_048_576) {
          await reader.cancel();
          throw new ProviderError("invalid_response");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return normalize(
        JSON.parse(new TextDecoder().decode(bytes)),
        Date.now(),
        ttlMinutes,
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("invalid_response");
    }
  },
};
export const providers = { "github-statuspage": githubProvider };
