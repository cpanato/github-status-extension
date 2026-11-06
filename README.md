# GitHub Status Indicator

A small, local-first Chrome / Chromium extension for GitHub's published service health. Manifest V3, no account, no backend, no telemetry.

The first version includes the overall status, affected-first service list, active incidents and scheduled maintenance, a GitHub toolbar icon colored by status, background polling, persistent cache, manual refresh, system/light/dark themes, and update interval settings. Only `storage`, `alarms`, and access to `https://www.githubstatus.com/*` are requested.

## Install a release in Chrome

Download a ready-to-use ZIP from [GitHub Releases](https://github.com/cpanato/github-status-extension/releases). You do not need Node.js, Go, npm, or a copy of the source repository to use a release.

### Choose where to keep the extension

Chrome loads an unpacked extension directly from the folder you select. **Keep that extracted folder in a permanent location while the extension is installed.** The ZIP can be deleted after extraction.

Suggested locations for this project:

| System  | Suggested installation folder            |
| ------- | ---------------------------------------- |
| macOS   | `~/Applications/github-status-extension` |
| Linux   | `~/.local/share/github-status-extension` |
| Windows | `%LOCALAPPDATA%\GitHubStatusExtension`   |

These are suggestions, not required Chrome locations. You can choose another permanent folder, including a directory on another drive. The destination is selected when you click **Load unpacked**; there is no installation-path setting inside the extension. Use the same folder for later updates. Chrome manages its own profile folders; you do not need to copy files into them.

### Download, extract, and load

1. Open the release you want to test. Under **Assets**, download `github-status-extension-<version>.zip` and, optionally, its matching `.zip.sha256` checksum. The automatically generated **Source code** archives contain the development source, not the ready-to-use extension.
2. Create your permanent installation folder and extract the ZIP contents into it.
3. Check that `manifest.json` is directly inside that folder:

   ```text
   github-status-extension/
     manifest.json
     popup.html
     options.html
     background/
     icons/
     ui/
     ...
   ```

4. Open `chrome://extensions` in Chrome and enable **Developer mode**.
5. Click **Load unpacked** and select the folder containing `manifest.json`.
6. Open Chrome's extensions menu (the puzzle icon), find **GitHub Status Indicator**, and pin it to the toolbar. Click the GitHub icon to view status; use the gear in the popup for preferences.

On macOS, for example, after downloading the ZIP to Downloads:

```bash
release_version=0.1.0-rc.3 # Replace with the version you downloaded.
extension_dir="$HOME/Applications/github-status-extension" # Change to your preferred folder.
mkdir -p "$extension_dir"
unzip "$HOME/Downloads/github-status-extension-$release_version.zip" -d "$extension_dir"
open "$extension_dir"
```

In Chrome, select that `github-status-extension` folder. In the folder picker, **Command–Shift–G** lets you paste its full path. For the suggested location, enter `~/Applications/github-status-extension`.

For an optional checksum check on macOS, keep the ZIP and its checksum in the same directory and run:

```bash
cd "$HOME/Downloads"
release_version=0.1.0-rc.3 # Replace with the version you downloaded.
shasum -a 256 -c "github-status-extension-$release_version.zip.sha256"
```

### Update an installed release

1. Download the next release's ZIP and extract its contents into the **same installation folder**, replacing the existing extension files. Keep `manifest.json` at the same location; avoid adding a nested folder named after the new version.
2. Open `chrome://extensions`, find **GitHub Status Indicator**, and click its **Reload** button (the circular arrow).
3. Open **Details** to check the displayed version, then open the popup to confirm the update. Use **Reload** for updates rather than removing and re-adding the extension.

Updates are manual while releases are installed this way. If you move or delete the extracted folder, Chrome can no longer load that installation. Choose the permanent location before the first install; keep Downloads and temporary build/worktree directories for downloads and development.

This uses Chrome's documented [Load unpacked and Reload workflow](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked), also used for local builds of extensions such as [Bitwarden](https://contributing.bitwarden.com/getting-started/clients/browser/) and [Stylus](https://github.com/openstyles/stylus/wiki/Install-Stylus-from-GitHub).

## Build from source (development)

Requires Node.js 26 LTS or newer and npm. The `.nvmrc` file selects Node 26 for local development and CI; run `nvm install && nvm use` if you use nvm. Bash, jq, zip, and shasum are used for packaging.

```bash
npm ci --ignore-scripts
npm run build
```

For development, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the generated `dist` directory inside your checkout/worktree. This directory contains `manifest.json`. Rebuild and click **Reload** after code changes. For an installation independent of the checkout, copy the contents of `dist` into your chosen permanent folder and follow the release installation steps above.

```bash
npm run package
```

The distributable is `artifacts/github-status-extension-0.1.0.zip`, accompanied by a `.zip.sha256` checksum. It contains compiled extension code and assets only. It is not automatically published to the Chrome Web Store.

## Releases and release candidates

Push a tag matching the version in both `package.json` and `public/manifest.json`: `v0.1.0` for a stable release, or `v0.1.0-rc.1` for a release candidate. The dedicated Release workflow runs its own validation, tests, and build without calling CI, stamps `version_name` into the built manifest, and publishes the ZIP and SHA-256 checksum to GitHub Releases. RC tags are marked as prereleases and do not become the latest stable release. Chrome's numeric `version` remains `0.1.0` for this release series.

The dedicated Release workflow runs only when a version tag is pushed; it has no manual trigger. It verifies the tag points at the checked-out source and refuses version mismatches. Only the publishing job has repository write permissions; it downloads the tested artifact and verifies the checksum without checking out or executing project code.

The repository enables release immutability. Publication creates a draft, uploads every asset, downloads and verifies the uploaded package, and only then publishes the draft. Published assets and tags are never replaced. If publication fails, the release stays unpublished; fix the issue and cut a new RC instead of overwriting assets. Future cosign signatures must be included before publication.

To test a published RC, follow [Install a release in Chrome](#install-a-release-in-chrome) above. RC and stable ZIPs use the same installation and update procedure.

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
- Manual refresh requests the latest status immediately, even when cached data is fresh or an automatic retry is scheduled. The configured interval applies only to background checks. The button shows progress and confirms success or failure, and the update time includes seconds. An explicit provider `Retry-After` temporarily disables refresh with a visible countdown. Failed automatic checks use exponential backoff with jitter. Requests time out after ten seconds, reject redirects, omit credentials, and cap response size at 1 MiB.
- The summary API supplies unresolved incidents, not resolved incident history. This MVP does not request extra historical feeds or invent uptime metrics.
- GitHub is the only configured source in this release. Multiple sources, GitLab, and runtime host permissions are deferred to later milestones. The normalized domain and provider interface are separate from the GitHub schema.
- Browser-based status is informational and reflects GitHub's published reports. Toolbar updates occur when Chrome wakes the service worker; they cannot update while the browser is suspended.

Architecture: `src/providers` validates and normalizes public data, `src/domain.ts` defines provider-independent models and severity, `src/background` owns polling/cache/toolbar, and `src/ui` renders local pages with safe text nodes. Native TypeScript modules keep the build small without a runtime framework or bundler. Bash orchestrates build and packaging; Go generates PNG assets.

The design is in [docs/design/github-status-extension-design.md](docs/design/github-status-extension-design.md). Reference APIs: [GitHub Status](https://www.githubstatus.com/api), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms).
