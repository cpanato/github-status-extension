# GitHub Status Indicator

A small, local-first Chrome / Chromium extension for GitHub's published service health. Manifest V3, no account, no backend, no telemetry.

The first version includes the overall status, affected-first service list, active incidents and scheduled maintenance, a GitHub toolbar icon colored by status, background polling, persistent cache, manual refresh, system/light/dark themes, and update interval settings. Only `storage`, `alarms`, and access to `https://www.githubstatus.com/*` are requested.

## Build and install

Requires Node.js 26 LTS or newer and npm. The `.nvmrc` file selects Node 26 for local development and CI; run `nvm install && nvm use` if you use nvm. Bash, jq, zip, and shasum are used for packaging.

```bash
npm ci --ignore-scripts
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this worktree's `dist` directory. Pin **GitHub Status Indicator** to the toolbar. No login or configuration is needed. Open settings using the gear in the popup.

```bash
npm run package
```

The distributable is `artifacts/github-status-extension-0.1.0.zip`, accompanied by a `.zip.sha256` checksum. It contains compiled extension code and assets only. It is not automatically published to the Chrome Web Store.

## Releases and release candidates

Push a tag matching the version in both `package.json` and `public/manifest.json`: `v0.1.0` for a stable release, or `v0.1.0-rc.1` for a release candidate. The dedicated Release workflow runs its own validation, tests, and build without calling CI, stamps `version_name` into the built manifest, and publishes the ZIP and SHA-256 checksum to GitHub Releases. RC tags are marked as prereleases and do not become the latest stable release. Chrome's numeric `version` remains `0.1.0` for this release series.

The dedicated Release workflow runs only when a version tag is pushed; it has no manual trigger. It verifies the tag points at the checked-out source and refuses version mismatches. Only the publishing job has repository write permissions; it downloads the tested artifact and verifies the checksum without checking out or executing project code.

The repository enables release immutability. Publication creates a draft, uploads every asset, downloads and verifies the uploaded package, and only then publishes the draft. Published assets and tags are never replaced. If publication fails, the release stays unpublished; fix the issue and cut a new RC instead of overwriting assets. Future cosign signatures must be included before publication.

To test a published RC, download and extract its ZIP, open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** with the extracted directory. To verify the download, put the ZIP and checksum in the same directory and run `shasum -a 256 -c github-status-extension-0.1.0-rc.1.zip.sha256`.

To prepare an RC locally without publishing:

```bash
npm run build
bash scripts/prepare-release.sh v0.1.0-rc.1
bash scripts/package.sh
```

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run test:release
npm run build
npx playwright install chromium
npm run test:e2e
npm audit --audit-level=moderate
```

Playwright loads the built extension into a real Chromium profile. Tests replace only the worker's external HTTP transport with deterministic fixtures; extension messaging, storage, alarms, toolbar APIs, and pages are exercised directly. Light/dark screenshots are saved in `test-results`. CI installs Chromium system dependencies too. Run `npm run format` to format source files. Icons can be regenerated using `go run scripts/icons.go`.

## Behavior and limitations

- The default check interval is one minute; settings offer 1, 2, 5, or 10 minutes. Chrome can delay alarms during sleep. Freshness is checked whenever the worker or popup runs.
- A failed check retains the last successful snapshot, marks it stale, and changes the toolbar to unknown. Expired data is never treated as fresh operational status. Cached service rows are labeled explicitly.
- The GitHub toolbar icon is green for operational status, yellow for degraded performance or maintenance, red for partial or major outages, and gray for unknown, stale, or failed checks. Attention/outage badges and tooltip text provide status information beyond color. The Chrome Extensions page uses a neutral GitHub icon. Icon sources and regeneration instructions are in [assets/README.md](assets/README.md).
- Manual refresh respects the next permitted check time. Failed checks use exponential backoff with jitter and honor bounded `Retry-After` values. Requests time out after ten seconds, reject redirects, omit credentials, and cap response size at 1 MiB.
- The summary API supplies unresolved incidents, not resolved incident history. This MVP does not request extra historical feeds or invent uptime metrics.
- GitHub is the only configured source in this release. Multiple sources, GitLab, and runtime host permissions are deferred to later milestones. The normalized domain and provider interface are separate from the GitHub schema.
- Browser-based status is informational and reflects GitHub's published reports. Toolbar updates occur when Chrome wakes the service worker; they cannot update while the browser is suspended.

Architecture: `src/providers` validates and normalizes public data, `src/domain.ts` defines provider-independent models and severity, `src/background` owns polling/cache/toolbar, and `src/ui` renders local pages with safe text nodes. Native TypeScript modules keep the build small without a runtime framework or bundler. Bash orchestrates build and packaging; Go generates PNG assets.

The design is in [docs/design/github-status-extension-design.md](docs/design/github-status-extension-design.md). Reference APIs: [GitHub Status](https://www.githubstatus.com/api), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms).
