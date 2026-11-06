#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts
rm -f artifacts/github-status-extension-0.1.0.zip
(cd dist && zip -qr ../artifacts/github-status-extension-0.1.0.zip .)
