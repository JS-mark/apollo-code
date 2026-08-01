#!/usr/bin/env bash
set -euo pipefail
sandbox_bin=${1:?apollo-sandbox binary required}
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
baseline=$(printf '{"command":"printf allowed > %s/allowed","cwd":"%s","permissions":{"fs":{"read":["%s/**"],"write":["%s/**"]},"net":false,"env":{"read":[]}},"env":{}}' "$work_dir" "$work_dir" "$work_dir" "$work_dir")
baseline_result=$("$sandbox_bin" exec <<<"$baseline")
[[ $baseline_result == *'"exit_code":0'* ]]
test "$(cat "$work_dir/allowed")" = allowed

escape=$(printf '{"command":"printf blocked > /tmp/apollo-escape-test","cwd":"%s","permissions":{"fs":{"read":["%s/**"],"write":["%s/**"]},"net":false,"env":{"read":[]}},"env":{}}' "$work_dir" "$work_dir" "$work_dir")
escape_result=$("$sandbox_bin" exec <<<"$escape")
[[ $escape_result != *'"exit_code":0'* ]]
test ! -e /tmp/apollo-escape-test
