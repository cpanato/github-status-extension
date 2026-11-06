#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
./node_modules/.bin/tsc
cp -R public/. dist/
