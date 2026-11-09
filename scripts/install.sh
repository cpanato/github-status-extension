#!/usr/bin/env bash
# Install only releases authenticated by this repository's tag release workflow.
set -euo pipefail
umask 077

repository=cpanato/github-status-extension
issuer=https://token.actions.githubusercontent.com
release_tag=
destination=
source_dir=
update=false
work_dir=
stage_dir=
lock_dir=
lock_acquired=false
previous_moved=false
backup=

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash install.sh [--update] [--version vX.Y.Z[-rc.N]] [--dir PATH] [--from PATH]

Installs the latest stable signed release by default. --version selects a tag.
--dir selects a permanent folder. --from uses already downloaded release assets
and requires --version. Cosign signature and SHA-256 verification are mandatory.
macOS/Linux only; requires cosign, jq, unzip, and shasum or sha256sum.
Online downloads also require authenticated GitHub CLI (gh) for the private repo.
After the first install, choose Load unpacked in chrome://extensions. After an
update, click Reload there. This script never modifies Chrome profile files.
HELP
}
cleanup() {
  if [[ "$previous_moved" == true && ! -e "$destination" && -d "$backup" ]]; then
    mv "$backup" "$destination" || printf 'Restore the previous installation from %s\n' "$backup" >&2
  fi
  [[ -z "$stage_dir" ]] || rm -rf "$stage_dir"
  [[ -z "$work_dir" ]] || rm -rf "$work_dir"
  if [[ "$lock_acquired" == true ]]; then rmdir "$lock_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|--dir|--from)
      [[ $# -ge 2 && -n "$2" ]] || fail "Missing value for $1"
      case "$1" in --version) release_tag=$2;; --dir) destination=$2;; --from) source_dir=$2;; esac
      shift 2;;
    --update) update=true; shift;;
    --help|-h) usage; exit 0;;
    *) fail "Unknown option: $1";;
  esac
done
case "$(uname -s)" in
  Darwin) default_dir="$HOME/Applications/github-status-extension";;
  Linux) default_dir="${XDG_DATA_HOME:-$HOME/.local/share}/github-status-extension";;
  *) fail 'The installer supports macOS and Linux. Use manual unpacked installation on Windows.';;
esac
[[ -n "$destination" ]] || destination=$default_dir
[[ -z "$release_tag" || "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[1-9][0-9]*)?$ ]] || fail 'Invalid version tag'
[[ -z "$source_dir" || -n "$release_tag" ]] || fail '--from requires --version'
for dependency in cosign jq unzip awk; do command -v "$dependency" >/dev/null || fail "Required command not found: $dependency"; done
if command -v sha256sum >/dev/null; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
else
  command -v shasum >/dev/null || fail 'Required command not found: shasum or sha256sum'
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
fi
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/github-status-extension.download.XXXXXX")
if [[ -z "$source_dir" ]]; then
  command -v gh >/dev/null || fail 'Install GitHub CLI (gh), then authenticate using gh auth login'
  endpoint="repos/$repository/releases/latest"
  [[ -z "$release_tag" ]] || endpoint="repos/$repository/releases/tags/$release_tag"
  gh api "$endpoint" > "$work_dir/release.json" || fail 'Cannot read release. Check gh authentication and repository access.'
  jq -e '.draft == false and .immutable == true' "$work_dir/release.json" >/dev/null || fail 'Only published immutable releases are accepted'
  if [[ -z "$release_tag" ]]; then jq -e '.prerelease == false' "$work_dir/release.json" >/dev/null || fail 'Latest must be a stable release'; fi
  resolved_tag=$(jq -er .tag_name "$work_dir/release.json")
  [[ -z "$release_tag" || "$resolved_tag" == "$release_tag" ]] || fail 'Returned release does not match the requested tag'
  release_tag=$resolved_tag
  [[ "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[1-9][0-9]*)?$ ]] || fail 'Release has an invalid tag'
  archive="github-status-extension-${release_tag#v}.zip"
  for asset in "$archive" SHA256SUMS SHA256SUMS.sigstore.json; do
    jq -e --arg name "$asset" '[.assets[] | select(.name == $name and .state == "uploaded" and .size > 0 and .size <= 16777216)] | length == 1' "$work_dir/release.json" >/dev/null || fail "Missing or oversized signed-release asset: $asset. Unsigned releases (including v0.1.0) are not supported."
    gh release download "$release_tag" --repo "$repository" --pattern "$asset" --dir "$work_dir" || fail "Cannot download $asset"
  done
else
  archive="github-status-extension-${release_tag#v}.zip"
  for asset in "$archive" SHA256SUMS SHA256SUMS.sigstore.json; do
    [[ -f "$source_dir/$asset" && ! -L "$source_dir/$asset" ]] || fail "Missing regular release asset: $asset"
    [[ $(wc -c < "$source_dir/$asset") -le 16777216 ]] || fail "Release asset too large: $asset"
    cp "$source_dir/$asset" "$work_dir/$asset"
  done
fi
identity="https://github.com/$repository/.github/workflows/release.yml@refs/tags/$release_tag"
printf 'Verifying signature for %s...\n' "$release_tag"
cosign verify-blob --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" \
  --bundle "$work_dir/SHA256SUMS.sigstore.json" "$work_dir/SHA256SUMS" || fail 'Cosign verification failed; installation unchanged'
expected=$(awk -v asset="$archive" 'NF == 2 && $2 == asset {print $1}' "$work_dir/SHA256SUMS")
[[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Signed checksums must contain exactly one valid ZIP checksum'
[[ "$(sha256 "$work_dir/$archive")" == "$expected" ]] || fail 'ZIP checksum mismatch; installation unchanged'
# Never pass untrusted filenames from the checksum file to a shell or hash tool.
# Validate archive paths and types before extraction, even after authentication.
entries=$(unzip -Z1 "$work_dir/$archive") || fail 'Invalid ZIP archive'
[[ -n "$entries" ]] || fail 'Empty ZIP archive'
entry_count=0
while IFS= read -r entry; do
  entry_count=$((entry_count + 1))
  [[ $entry_count -le 2000 && "$entry" =~ ^[A-Za-z0-9_./-]+$ && "$entry" != /* && "$entry" != *'//'* && "/$entry/" != *'/../'* && "/$entry/" != *'/./'* ]] || fail 'Unsafe ZIP path or too many entries'
done <<< "$entries"
[[ $(printf '%s\n' "$entries" | LC_ALL=C sort -fu | wc -l) -eq "$entry_count" ]] || fail 'Duplicate ZIP paths are not accepted'
listing=$(unzip -Z -l "$work_dir/$archive") || fail 'Cannot inspect ZIP file types'
uncompressed=$(printf '%s\n' "$listing" | awk -v expected="$entry_count" '
  length($1) == 10 && $1 ~ /^[[:alpha:]-]+$/ && $2 ~ /^[0-9]+\.[0-9]+$/ {
    if ((substr($1,1,1) != "-" && substr($1,1,1) != "d") || $4 !~ /^[0-9]+$/) bad=1
    count++; sum += $4
  }
  END {if (bad || count != expected) exit 1; printf "%.0f",sum}
') || fail 'Only regular files and directories are accepted in extension packages'
[[ "$uncompressed" -le 33554432 ]] || fail 'Uncompressed package is too large'
[[ ! -L "$destination" ]] || fail 'The installation folder must not be a symlink'
install_leaf=$(basename "$destination")
[[ "$install_leaf" != . && "$install_leaf" != .. && "$install_leaf" != / ]] || fail 'Choose a dedicated installation folder'
mkdir -p "$(dirname "$destination")"
parent=$(cd "$(dirname "$destination")" && pwd -P)
destination="$parent/$(basename "$destination")"
backup="$destination.previous"
lock_dir="$destination.install.lock"
mkdir "$lock_dir" 2>/dev/null || fail "Another installation may be running: $lock_dir"
lock_acquired=true
owned_installation() {
  [[ -f "$1/manifest.json" && ! -L "$1/manifest.json" ]] &&
    jq -e '.manifest_version == 3 and .name == "GitHub Status Indicator" and .background.service_worker == "background/index.js" and .host_permissions == ["https://www.githubstatus.com/*"]' "$1/manifest.json" >/dev/null
}
if [[ -e "$destination" ]]; then
  [[ -d "$destination" ]] || fail 'Installation path is not a directory'
  if [[ -n "$(ls -A "$destination")" ]]; then owned_installation "$destination" || fail 'Refusing to replace an unrelated directory'; fi
  if [[ "$update" == true ]] && ! owned_installation "$destination"; then fail 'No installation found in this folder'; fi
elif [[ "$update" == true ]]; then
  fail 'No installation found at this path; run without --update or choose the existing folder with --dir'
fi
if [[ -e "$backup" || -L "$backup" ]]; then
  if [[ -L "$backup" ]] || ! owned_installation "$backup"; then fail 'Refusing to replace an unrelated backup'; fi
fi
stage_dir=$(mktemp -d "$parent/.github-status-extension.stage.XXXXXX")
unzip -q "$work_dir/$archive" -d "$stage_dir"
owned_installation "$stage_dir" || fail 'Package is not the expected extension'
jq -e --arg version "${release_tag#v}" --arg base "${release_tag#v}" '.version_name == $version and .version == ($base | split("-")[0])' "$stage_dir/manifest.json" >/dev/null || fail 'Manifest version does not match the signed release tag'
[[ -f "$stage_dir/popup.html" && -f "$stage_dir/background/index.js" ]] || fail 'Incomplete extension package'
jq -n --arg repository "$repository" --arg version "$release_tag" --arg identity "$identity" '{repository:$repository,version:$version,verifiedIdentity:$identity}' > "$stage_dir/.github-status-extension-install.json"
# Stage on the same filesystem, preserve the fixed Chrome path, and restore the
# old directory automatically if promotion fails. Backups stay outside the app.
if [[ -d "$destination" && -z "$(ls -A "$destination")" ]]; then rmdir "$destination"; fi
if [[ -e "$destination" ]]; then
  [[ ! -e "$backup" ]] || rm -rf "$backup"
  mv "$destination" "$backup"
  previous_moved=true
fi
mv "$stage_dir" "$destination"
stage_dir=
previous_moved=false
printf '\nInstalled %s (cosign + SHA-256 verified)\nFolder: %s\n' "$release_tag" "$destination"
printf 'First install: open chrome://extensions, enable Developer mode, choose Load unpacked, and select this folder.\n'
printf 'Existing install: click Reload for GitHub Status Indicator in chrome://extensions.\n'
[[ ! -d "$backup" ]] || printf 'Previous files: %s\n' "$backup"
