#!/usr/bin/env bash
# Real cosign: a valid signature from an arbitrary local key is not trusted.
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
command -v cosign >/dev/null
crypto_dir=$(mktemp -d)
trap 'rm -rf "$crypto_dir"' EXIT
export COSIGN_PASSWORD=
archive=github-status-extension-9.9.1.zip
printf 'fixture archive; extraction must never occur\n' > "$crypto_dir/$archive"
(cd "$crypto_dir" && shasum -a 256 "$archive" > SHA256SUMS)
cosign generate-key-pair --output-key-prefix "$crypto_dir/local" >/dev/null 2>&1
# This fixture deliberately has no OIDC certificate, TSA, or transparency log.
# No test signatures or private keys are uploaded to public services.
cosign signing-config create --no-default-fulcio --no-default-oidc --no-default-rekor --no-default-tsa --out "$crypto_dir/config.json"
cosign sign-blob --yes --key "$crypto_dir/local.key" --signing-config "$crypto_dir/config.json" --bundle "$crypto_dir/SHA256SUMS.sigstore.json" "$crypto_dir/SHA256SUMS" >/dev/null 2>&1
# The unsafe flag is confined to this local-key positive control. The installer
# never uses this flag or accepts a caller-supplied key/identity/issuer.
cosign verify-blob --key "$crypto_dir/local.pub" --insecure-ignore-tlog --bundle "$crypto_dir/SHA256SUMS.sigstore.json" "$crypto_dir/SHA256SUMS" >/dev/null 2>&1
mkdir "$crypto_dir/installed"
printf 'keep\n' > "$crypto_dir/installed/sentinel"
if bash "$project_dir/scripts/install.sh" --version v9.9.1 --from "$crypto_dir" --dir "$crypto_dir/installed" > "$crypto_dir/result" 2>&1; then
  echo 'Installer accepted a signature without the trusted workflow certificate' >&2
  exit 1
fi
[[ "$(cat "$crypto_dir/result")" == *'Cosign verification failed'* ]]
test "$(cat "$crypto_dir/installed/sentinel")" = keep
printf 'tampered\n' >> "$crypto_dir/SHA256SUMS"
if cosign verify-blob --key "$crypto_dir/local.pub" --insecure-ignore-tlog --bundle "$crypto_dir/SHA256SUMS.sigstore.json" "$crypto_dir/SHA256SUMS" >/dev/null 2>&1; then
  echo 'Cosign accepted a tampered signed checksum file' >&2
  exit 1
fi
echo 'Real cosign rejects an untrusted publisher and tampered signed checksums.'
