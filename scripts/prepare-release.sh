#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
release_tag=${1:?Usage: prepare-release.sh vX.Y.Z[-rc.N]}
if [[ ! "$release_tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-rc\.[1-9][0-9]*)?$ ]]; then
  echo 'Expected a tag in the form vX.Y.Z or vX.Y.Z-rc.N' >&2
  exit 1
fi
base_version=${BASH_REMATCH[1]}
package_version=$(jq -er .version package.json)
manifest_version=$(jq -er .version dist/manifest.json)
if [[ "$package_version" != "$base_version" || "$manifest_version" != "$base_version" ]]; then
  echo 'Tag, package.json, and manifest.json versions must match' >&2
  exit 1
fi
# Chrome requires a numeric version; version_name carries the RC suffix.
jq --arg version "${release_tag#v}" '.version_name = $version' dist/manifest.json > dist/manifest.release.json
mv dist/manifest.release.json dist/manifest.json
