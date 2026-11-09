#!/usr/bin/env bash
# Flow tests use explicit gh/cosign shims; signature rejection has a separate test.
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir -p "$test_dir/bin" "$test_dir/releases"
real_mv=$(command -v mv)
export real_mv
export TEST_RELEASES="$test_dir/releases"
export TEST_DOWNLOAD_TAG=v9.9.1
export PATH="$test_dir/bin:$PATH"
cat > "$test_dir/bin/cosign" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == verify-blob ]]; shift
identity= issuer= bundle= file=
while [[ $# -gt 0 ]]; do
 case "$1" in
 --certificate-identity) identity=$2; shift 2;;
 --certificate-oidc-issuer) issuer=$2; shift 2;;
 --bundle) bundle=$2; shift 2;;
 -*) exit 1;;
 *) file=$1; shift;;
 esac
done
[[ "$identity" == https://github.com/cpanato/github-status-extension/.github/workflows/release.yml@refs/tags/v* ]]
[[ "$issuer" == https://token.actions.githubusercontent.com ]]
if command -v sha256sum >/dev/null; then digest=$(sha256sum "$file" | awk '{print $1}'); else digest=$(shasum -a 256 "$file" | awk '{print $1}'); fi
jq -e --arg identity "$identity" --arg issuer "$issuer" --arg digest "$digest" '.identity == $identity and .issuer == $issuer and .digest == $digest' "$bundle" >/dev/null
MOCK
cat > "$test_dir/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == api ]]; then cat "$TEST_RELEASES/$TEST_DOWNLOAD_TAG/release.json"; exit; fi
[[ "$1" == release && "$2" == download ]]; tag=$3; shift 3
pattern= destination=
while [[ $# -gt 0 ]]; do
 case "$1" in --repo) [[ "$2" == cpanato/github-status-extension ]];shift 2;; --pattern) pattern=$2;shift 2;; --dir) destination=$2;shift 2;; *) exit 1;; esac
done
cp "$TEST_RELEASES/$tag/$pattern" "$destination/"
MOCK
cat > "$test_dir/bin/mv" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${FAIL_PROMOTION:-0}" == 1 && "$1" == *'/.github-status-extension.stage.'* ]]; then exit 1; fi
exec "$real_mv" "$@"
MOCK
chmod +x "$test_dir/bin/"*
sign_fixture() {
 local dir=$1 tag=$2 archive="github-status-extension-${2#v}.zip" digest
 (cd "$dir" && shasum -a 256 "$archive" > SHA256SUMS)
 digest=$(shasum -a 256 "$dir/SHA256SUMS" | awk '{print $1}')
 jq -n --arg identity "https://github.com/cpanato/github-status-extension/.github/workflows/release.yml@refs/tags/$tag" --arg digest "$digest" '{identity:$identity,issuer:"https://token.actions.githubusercontent.com",digest:$digest}' > "$dir/SHA256SUMS.sigstore.json"
 jq -n --arg tag "$tag" --arg archive "$archive" '{tag_name:$tag,draft:false,prerelease:false,immutable:true,assets:[$archive,"SHA256SUMS","SHA256SUMS.sigstore.json"]|map({name:.,state:"uploaded",size:100})}' > "$dir/release.json"
}
make_release() {
 local tag=$1 dir="$TEST_RELEASES/$1"
 mkdir -p "$dir/root/background"
 jq -n --arg version "${tag#v}" '{name:"GitHub Status Indicator",manifest_version:3,version:($version|split("-")[0]),version_name:$version,background:{service_worker:"background/index.js"},host_permissions:["https://www.githubstatus.com/*"]}' > "$dir/root/manifest.json"
 printf 'popup %s\n' "$tag" > "$dir/root/popup.html"
 printf 'worker\n' > "$dir/root/background/index.js"
 (cd "$dir/root" && zip -qr "../github-status-extension-${tag#v}.zip" .)
 sign_fixture "$dir" "$tag"
}
install() { bash "$project_dir/scripts/install.sh" "$@" > "$test_dir/output" 2>&1; }
expect_failure() { if install "$@"; then cat "$test_dir/output"; echo 'Unexpected installation success' >&2; exit 1; fi; }
make_release v9.9.0
make_release v9.9.1
old="$TEST_RELEASES/v9.9.0"
new="$TEST_RELEASES/v9.9.1"
app="$test_dir/Custom folder/extension"
install --version v9.9.0 --from "$old" --dir "$app"
test "$(jq -r .version_name "$app/manifest.json")" = 9.9.0
install --update --version v9.9.1 --from "$new" --dir "$app"
test "$(jq -r .version_name "$app/manifest.json")" = 9.9.1
test "$(jq -r .version_name "$app.previous/manifest.json")" = 9.9.0
# A signature failure, digest mismatch, missing bundle, or unsafe option must not
# change the installed files, even with a known last-good installation present.
printf 'unchanged\n' > "$app/sentinel"
cp "$new/SHA256SUMS.sigstore.json" "$test_dir/valid-bundle"
jq '.issuer="https://evil.example"' "$test_dir/valid-bundle" > "$new/SHA256SUMS.sigstore.json"
expect_failure --version v9.9.1 --from "$new" --dir "$app"
jq '.identity="https://github.com/other/repo/.github/workflows/release.yml@refs/tags/v9.9.1"' "$test_dir/valid-bundle" > "$new/SHA256SUMS.sigstore.json"
expect_failure --version v9.9.1 --from "$new" --dir "$app"
cp "$test_dir/valid-bundle" "$new/SHA256SUMS.sigstore.json"
printf 'tampered\n' >> "$new/github-status-extension-9.9.1.zip"
expect_failure --version v9.9.1 --from "$new" --dir "$app"
rm "$new/github-status-extension-9.9.1.zip"
(cd "$new/root" && zip -qr ../github-status-extension-9.9.1.zip .)
rm "$new/SHA256SUMS.sigstore.json"
expect_failure --version v9.9.1 --from "$new" --dir "$app"
cp "$test_dir/valid-bundle" "$new/SHA256SUMS.sigstore.json"
expect_failure --skip-verify --dir "$app"
test "$(cat "$app/sentinel")" = unchanged
# Latest stable downloads use gh's existing authentication and require immutable
# release metadata. No tokens or profile paths are written to the installation.
sign_fixture "$new" v9.9.1
install --dir "$test_dir/online"
test -f "$test_dir/online/manifest.json"
expect_failure --version v9.9.0 --dir "$test_dir/wrong-version"
test ! -e "$test_dir/wrong-version"
jq '.immutable=false' "$new/release.json" > "$test_dir/metadata"
cp "$test_dir/metadata" "$new/release.json"
expect_failure --dir "$test_dir/mutable"
test ! -e "$test_dir/mutable"
sign_fixture "$new" v9.9.1
# Unknown directories, symlinks, and concurrent updates are protected.
mkdir "$test_dir/unrelated"; printf 'mine\n' > "$test_dir/unrelated/keep"
expect_failure --version v9.9.1 --from "$new" --dir "$test_dir/unrelated"
test -f "$test_dir/unrelated/keep"
ln -s "$app" "$test_dir/link"
expect_failure --version v9.9.1 --from "$new" --dir "$test_dir/link"
mkdir "$app.install.lock"
expect_failure --version v9.9.1 --from "$new" --dir "$app"
test -d "$app.install.lock"; rmdir "$app.install.lock"
expect_failure --update --version v9.9.1 --from "$new" --dir "$test_dir/missing"
# Failure while swapping staged files restores the previous directory.
export FAIL_PROMOTION=1
expect_failure --version v9.9.1 --from "$new" --dir "$app"
unset FAIL_PROMOTION
test "$(cat "$app/sentinel")" = unchanged
# A signed but malformed archive still cannot escape the staging directory.
mkdir -p "$test_dir/unsafe/inside"
printf 'escape\n' > "$test_dir/unsafe/escape"
(cd "$test_dir/unsafe/inside" && zip -q "$new/github-status-extension-9.9.1.zip" ../escape)
sign_fixture "$new" v9.9.1
expect_failure --version v9.9.1 --from "$new" --dir "$app"
rm "$new/github-status-extension-9.9.1.zip"
ln -s "$test_dir/unsafe/escape" "$new/root/link"
(cd "$new/root" && zip -qry ../github-status-extension-9.9.1.zip .)
sign_fixture "$new" v9.9.1
expect_failure --version v9.9.1 --from "$new" --dir "$app"
test "$(cat "$app/sentinel")" = unchanged
echo 'Installer verification, install/update, rollback, and archive-safety tests passed.'
