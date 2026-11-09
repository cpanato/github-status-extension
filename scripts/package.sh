#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
package_version=$(jq -er '.version_name // .version' dist/manifest.json)
if [[ ! "$package_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[1-9][0-9]*)?$ ]]; then
  echo 'Invalid package version' >&2
  exit 1
fi
mkdir -p artifacts
archive="github-status-extension-$package_version.zip"
rm -f "artifacts/$archive"
(cd dist && zip -qr "../artifacts/$archive" .)
(cd artifacts && shasum -a 256 "$archive" > "$archive.sha256")
cp scripts/install.sh artifacts/install.sh
(cd artifacts && shasum -a 256 "$archive" "$archive.sha256" install.sh > SHA256SUMS)
