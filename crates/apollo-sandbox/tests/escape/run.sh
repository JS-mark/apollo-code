#!/usr/bin/env bash
set -euo pipefail
sandbox_bin=${1:?apollo-sandbox binary required}
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
request=$(printf '{"command":"printf blocked > /tmp/apollo-escape-test","cwd":"%s","permissions":{"fs":{"read":["%s/**"],"write":["%s/**"]},"net":false,"env":{"read":[]}},"env":{}}' "$work_dir" "$work_dir" "$work_dir")
"$sandbox_bin" exec <<<"$request"
test ! -e /tmp/apollo-escape-test
