#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/scripts" "$test_dir/dist"
cp "$project_dir/scripts/prepare-release.sh" "$project_dir/scripts/package.sh" "$project_dir/scripts/install.sh" "$test_dir/scripts/"
printf '{"version":"0.1.0"}\n' > "$test_dir/package.json"
printf '{"version":"0.1.0","manifest_version":3}\n' > "$test_dir/dist/manifest.json"
cd "$test_dir"
for invalid in 'v0.1.0-rc.0' 'v0.1.0-beta.1' '0.1.0' 'v0.2.0' 'v0.1.0/../../x' 'v0.1.0;echo bad'; do
  if bash scripts/prepare-release.sh "$invalid" >/dev/null 2>&1; then
    echo "Unexpectedly accepted invalid release tag: $invalid" >&2
    exit 1
  fi
done
test "$(jq -r '.version_name // "missing"' dist/manifest.json)" = missing
bash scripts/prepare-release.sh v0.1.0-rc.1
test "$(jq -r .version dist/manifest.json)" = 0.1.0
test "$(jq -r .version_name dist/manifest.json)" = 0.1.0-rc.1
bash scripts/package.sh
(cd artifacts && shasum -a 256 -c github-status-extension-0.1.0-rc.1.zip.sha256)
(cd artifacts && shasum -a 256 -c SHA256SUMS)
test "$(unzip -p artifacts/github-status-extension-0.1.0-rc.1.zip manifest.json | jq -r .version_name)" = 0.1.0-rc.1
bash scripts/prepare-release.sh v0.1.0
bash scripts/package.sh
test -f artifacts/github-status-extension-0.1.0.zip
jq '.version = "0.2.0"' dist/manifest.json > dist/mismatch.json
mv dist/mismatch.json dist/manifest.json
if bash scripts/prepare-release.sh v0.1.0 >/dev/null 2>&1; then
  echo 'Unexpectedly accepted mismatched manifest version' >&2
  exit 1
fi
jq '.version_name = "../../bad"' dist/manifest.json > dist/invalid.json
mv dist/invalid.json dist/manifest.json
if bash scripts/package.sh >/dev/null 2>&1; then
  echo 'Unexpectedly accepted invalid package filename' >&2
  exit 1
fi
echo 'Release validation and packaging tests passed.'
