# GitHub Status Extension — Technical Design

**Status:** Proposed  
**Version:** 0.1  
**Date:** 2026-11-06  
**Repository:** `github-status-extension` (working name)  
**Language:** English  
**Target:** Chrome / Chromium, Manifest V3

## 1. Summary

Build a lightweight, privacy-preserving browser extension that displays the operational status of developer platforms. The first release targets GitHub Status with a compact, attractive popup resembling the visual hierarchy of the official status site. The architecture must allow GitLab.com and user-configured GitLab Self-Managed instances, then other status systems, without redesigning the UI.

**Principle:** separate **data source adapters**, **normalized status models**, **polling/cache**, and **presentation**. Do not confuse a provider's published incident status with an endpoint reachability check.

## 2. Goals and non-goals

### Goals

- One-click, visual overview of overall status, individual components, and relevant incidents.
- Toolbar icon conveys the highest-severity **known** issue among enabled sources.
- GitHub works immediately with no account, token, or server.
- User-configurable list of sources, with independent settings and health checks.
- Local-first storage, no tracking, minimal permissions, keyboard/screen-reader accessibility.
- Secure, testable code and automated CI, with a small build output.

### Non-goals for v1

- Monitoring repositories, commits, pipelines, or individual jobs.
- Historical uptime calculations based on incomplete incident feeds.
- Credentials for private services or automatic sign-in integration.
- Backend, cloud synchronization, external notification service, or analytics.
- Promising precise service health from a single HTTP probe.

## 3. Product experience

### Toolbar

- Small status marker: green (operational), amber (degraded), red (major/critical outage), gray (unknown, unavailable, or no data).
- If multiple sources are configured, calculate an aggregate based on the **worst severity of fresh, known statuses**. Indicate partial coverage when any source is stale or unknown; never label the whole collection healthy solely because some sources are healthy.
- Tooltip: `GitHub: Operational`, or `2 affected · 1 unknown`; provide detailed, accessible status text inside the popup.

### Popup (initial width approximately 400–440 px)

1. Header with product icon, title, platform selector, settings button, and external status-page link.
2. Large semantic status panel: **All Systems Operational** / **Degraded Performance** / **Partial Outage** / **Major Outage** / **Status Unavailable**.
3. Component rows with icon, component name, textual state, and colored badge. Order affected services first; allow user favorites later.
4. Active incidents card with title, severity, timestamp, and link to original status page.
5. Recent resolved incidents, collapsed by default.
6. Footer: `Updated HH:MM`, manual refresh, API attribution, and a stale/error message if relevant.

Light/dark mode follows the browser/system preference by default. Never communicate state by color alone. Provide loading, empty, offline, permission-denied, and stale-cache states. Responsive scrolling in constrained popup height.

**Historical uptime section:** optional **only where a provider exposes reliable history or uptime data**. Do not display an invented `99.99%` metric or 7-day chart based only on a current status summary.

### Settings / Options page

- Sources list: add, rename, enable/disable, reorder, delete.
- Add-source wizard: provider type, display name, endpoint/base URL, permissions explanation, connection test.
- Polling interval: default 60 seconds for supported sources; user choice among safe presets, subject to browser limits and provider rate restrictions.
- Theme: system/light/dark.
- Selected services (future enhancement).
- Diagnostic status: last success, last failure, error category, cache age; **no sensitive response bodies or tokens**.

## 4. Providers and rollout

| Provider adapter | Endpoint strategy | Scope | Release |
|---|---|---|---|
| `github-statuspage` | `https://www.githubstatus.com/api/v2/summary.json` | Overall status, components, unresolved incidents, maintenance | MVP |
| `gitlab-saas` | Official `https://status.gitlab.com/` source; investigate/validate machine-readable interface during implementation | GitLab.com published service status | Phase 2 |
| `gitlab-self-managed` | User-authorized `https://gitlab.example.com/-/health`, optionally `/-/readiness` and permitted checks | Reachability/liveness/readiness, not a full incident feed | Phase 2 |
| `generic-statuspage` | Public Statuspage-compatible `/api/v2/summary.json` | Other Statuspage sites | Future |
| `custom-adapter` | Well-defined adapter interface | Status systems with other formats | Future |

**Important GitLab.com distinction:** `status.gitlab.com` is hosted on a different status-page system from GitHub's Atlassian Statuspage. Do **not** assume `/api/v2/summary.json` works for GitLab.com. Confirm an official documented public feed/API and its browser access constraints before implementing the adapter; otherwise ship GitLab.com as a link-only or explicitly unsupported source until a reliable integration is available.

**Important GitLab Self-Managed distinction:** `/-/health` checks that the application server is running, **not** dependent services. `/-/readiness?all=1` can check dependencies but may be limited by IP allowlists, security policies, and deployment configuration. A healthy probe does not guarantee pipelines, Git operations, or other end-user workflows are healthy. Some probes are intended for local/load-balancer monitoring, may be inappropriate to poll publicly, and can produce false negatives in scaled deployments. Request no credentials in v1. An administrator must authorize probing and enable access as needed. Label these sources `Reachable` / `Ready` / `Unavailable` / `Unknown`, not `All Systems Operational` without evidence.

## 5. Data model

```ts
type HealthState =
  | 'operational'
  | 'degraded'
  | 'partial_outage'
  | 'major_outage'
  | 'maintenance'
  | 'unknown';

type CheckKind = 'published_status' | 'liveness' | 'readiness';

interface MonitoredSource {
  id: string;
  provider: 'github-statuspage' | 'gitlab-saas' | 'gitlab-self-managed' | 'generic-statuspage';
  label: string;
  baseUrl: string;
  enabled: boolean;
  checkKind: CheckKind;
  intervalMinutes: number;
}

interface StatusComponent {
  id: string;
  name: string;
  state: HealthState;
  description?: string;
}

interface StatusIncident {
  id: string;
  title: string;
  state: string;
  severity: HealthState;
  url?: string;
  updatedAt?: string;
  affectedComponentIds?: string[];
}

interface StatusSnapshot {
  sourceId: string;
  checkKind: CheckKind;
  overall: HealthState;
  summary: string;
  components: StatusComponent[];
  incidents: StatusIncident[];
  checkedAt: string;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
  error?: 'network' | 'timeout' | 'permission' | 'invalid_response' | 'http_error';
}

interface StatusProvider {
  readonly id: MonitoredSource['provider'];
  fetchStatus(source: MonitoredSource, signal: AbortSignal): Promise<StatusSnapshot>;
}
```

Use provider-specific mapping layers. Preserve useful provider metadata without leaking it into the generic popup components. Do not collapse transport errors into an `operational` state.

## 6. Runtime architecture

```text
Options Page ───────────────┐
                            ▼
Popup UI ───────────► Source Registry (chrome.storage.local)
   ▲                        │
   │                        ▼
   └──── Status Cache ◄─ Polling Controller / MV3 Service Worker
                                │
                       Provider Adapter Registry
                        ├── GitHub Statuspage
                        ├── GitLab.com (future)
                        ├── GitLab Self-Managed (future)
                        └── Generic Statuspage (future)
                                │
                           HTTPS requests
```

- Use `chrome.alarms`, not a long-running `setInterval`, for periodic background checks; recreate alarms as necessary when the service worker restarts.
- Allow at most one in-flight refresh per source; use abort timeouts, conservative backoff, jitter, and `Retry-After` where applicable.
- Store configuration and the last successful snapshot in `chrome.storage.local`. Use a timestamped cache with explicit TTL and source-specific error state. Never overwrite a usable last-known-good snapshot with an empty success payload on failed fetch.
- The popup reads cached results instantly, then requests a refresh only when needed. Service worker owns polling and toolbar icon updates.
- When a source changes or is removed, cancel its alarm, clear associated cache and revoke its now-unneeded runtime host permission when possible.

## 7. API integration

### GitHub (MVP)

`GET https://www.githubstatus.com/api/v2/summary.json`

The documented endpoint provides an aggregate status, components, unresolved incidents, and upcoming/in-progress maintenance. Additional official endpoints include `/api/v2/status.json`, `/api/v2/components.json`, and `/api/v2/incidents/unresolved.json`; prefer the single summary request when adequate to avoid extra traffic.

Map overall `indicator` (`none`, `minor`, `major`, `critical`) and component status (`operational`, `degraded_performance`, `partial_outage`, `major_outage`) carefully; unit-test mapping and unknown enum values. Use incident `shortlink` / trusted status-page URL when present, not a synthesized unvalidated URL.

### GitLab.com (Phase 2)

Use `https://status.gitlab.com/` as the canonical status URL; verify a supported machine-readable endpoint before building the adapter. Avoid scraping fragile HTML if the site does not provide a stable public interface; document any approved feed, response schema, availability, and CORS/extension-host-permission requirements.

### GitLab Self-Managed (Phase 2)

Accept an explicit administrator-approved HTTPS base URL and select a probe:

- `/-/health`: application liveness only, typical successful response `GitLab OK`.
- `/-/readiness`: readiness (can return HTTP 503 when not ready).
- `/-/readiness?all=1`: broader dependency checks **only when explicitly allowed and enabled**.

Check response code and type, cap response size, and use tight timeouts. Use `Unknown` when host permissions, VPN, network access, auth policy, or CORS constraints prevent a trustworthy result. Do not infer outages from an isolated probe failure without contextual messaging.

## 8. Browser permissions and security

Proposed MVP manifest (conceptual):

```json
{
  "manifest_version": 3,
  "name": "GitHub Status Indicator",
  "version": "0.1.0",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://www.githubstatus.com/*"],
  "optional_host_permissions": ["https://*/*"]
}
```

The broad **optional** HTTPS pattern is solely for future user-configured private hosts. Request origin-specific permission **at runtime** as part of adding that source; never require blanket permissions at installation. Confirm required permission constraints and UX in Chrome during implementation. Do not enable arbitrary `http://` origins by default; localhost testing can be handled separately in a development build. If broad optional permission declaration creates unacceptable store warnings, prefer a narrower permission strategy or revisit the self-managed host design.

Additional safeguards:

- No `tabs`, `history`, `cookies`, `webRequest`, content scripts, or credential access needed for MVP.
- No remotely hosted JavaScript; bundle all scripts/styles (MV3 CSP compliant).
- No `innerHTML` for remote content; use text nodes and sanitize/validate links.
- Strict HTTPS, URL parsing and hostname checks; never send private instance URLs to third parties.
- Avoid automatic redirects to unrelated hosts; validate the final origin of requests where technically feasible.
- Bound timeouts, response sizes, JSON parsing, list counts, and cache size; handle denial and invalid schemas gracefully.
- Store no personal access tokens in v1. Future credential support needs a separate security review and explicit threat model, not plain-text token configuration.
- Minimal dependencies, pinned CI actions and automated dependency review. No telemetry.

## 9. UI component breakdown

```text
src/
  app/
    popup/
      Popup.tsx
      StatusHero.tsx
      SourcePicker.tsx
      ComponentList.tsx
      IncidentList.tsx
      StatusFooter.tsx
    options/
      Options.tsx
      SourceForm.tsx
  background/
    index.ts
    polling.ts
    toolbar.ts
  providers/
    types.ts
    registry.ts
    github.ts
    gitlab-saas.ts           # phase 2
    gitlab-self-managed.ts   # phase 2
  domain/
    status.ts
    severity.ts
  storage/
    config.ts
    snapshots.ts
  shared/
    fetch.ts
    validation.ts
    time.ts
  assets/
    icons/
tests/
  fixtures/
  unit/
  integration/
  e2e/
.github/workflows/
  ci.yml
  security.yml
```

Preferred tooling: TypeScript (strict), Vite + React for the popup/options or a smaller web-components approach if bundle size becomes an issue, Vitest, Playwright for Chromium end-to-end tests, ESLint, Prettier. Favor native browser APIs over dependencies where possible.

## 10. Tests and quality gates

- **Unit:** all severity mappings, unknown values, incident ordering, source aggregation, stale-cache behavior, timers/backoff, invalid URLs.
- **Provider fixtures:** success, degraded components, active incident, maintenance, 429/500, malformed JSON, network and timeout errors.
- **Integration:** service worker alarm lifecycle, storage persistence, permission grant/denial/removal, source creation and deletion.
- **E2E:** toolbar state, popup light/dark, cross-provider selection, accessibility basics, loading/offline modes, simulated self-managed sources.
- **Security:** `npm audit`/OSV or equivalent, dependency updates, least-privilege manifest review, CSP inspection, static checks. Use pinned GitHub Actions commits where practical, least-privilege workflow permissions, and no untrusted script execution.
- **CI:** typecheck → lint → unit → build → integration/E2E → artifact packaging. Review version/package publishing separately; do not auto-publish to the Chrome Web Store during MVP.

## 11. Milestones

**M0 — Foundation:** repo skeleton, TypeScript strict, Manifest V3, test setup, fixtures, CI, icons.

**M1 — GitHub MVP:** official summary endpoint adapter, normalization, popup matching approved mockup, toolbar badge, alarms/cache, errors, accessibility, theme, tests, buildable unpacked extension.

**M2 — Multiple sources:** source registry and options UI; aggregate status; runtime optional host permission flow; GitLab Self-Managed liveness/readiness integration with clear semantic labels; security tests.

**M3 — GitLab.com adapter:** only after confirming an approved, stable machine-readable status source; map platform-specific incident and component statuses. If no suitable source exists, keep a canonical-page link instead of shipping fragile parsing.

**M4 — Optional polish:** pinned/reordered services, incident notifications (opt-in), trustworthy historical uptime, import/export settings, generic Statuspage adapter, localization.

## 12. Acceptance criteria for GitHub MVP

1. Install unpacked in current stable Chrome; the extension needs no login or setup.
2. Popup clearly displays GitHub rollup, components, and current incidents or the empty state.
3. Toolbar changes for healthy, degraded, outage, and unknown scenarios.
4. Background updates and stale handling work even when the popup is closed.
5. A network outage does not misleadingly produce a green status.
6. No remote code or personal-data collection; scoped GitHub permission only in MVP.
7. Unit and end-to-end tests pass on GitHub Actions; package contains no development-only files.
8. Provider interfaces remain independent of GitHub's JSON shape.

## 13. Open decisions

- Keep repository name `github-status-extension` for the GitHub-first launch, or choose a provider-neutral name (e.g. `dev-status-extension`) before publishing GitLab support?
- Should multiple-provider support become visible in the MVP options page, or stay entirely behind the provider interface until M2?
- For self-managed hosts, is `Reachable` sufficient initially, or should admins explicitly opt into readiness/dependency checks?
- Should notifications be opt-in by provider and severity in a later release?

## 14. Official references

- GitHub Status API: https://www.githubstatus.com/api
- GitHub Status: https://www.githubstatus.com/
- GitLab.com published status: https://status.gitlab.com/
- GitLab Self-Managed health checks: https://docs.gitlab.com/administration/monitoring/health_check/
- GitLab incident status pages: https://docs.gitlab.com/operations/incident_management/status_page/
- Chrome extension permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- Chrome Manifest V3: https://developer.chrome.com/docs/extensions/develop/migrate/manifest
