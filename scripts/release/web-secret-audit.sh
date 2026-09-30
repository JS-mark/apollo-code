#!/usr/bin/env bash
# P6-05 Web console release secret audit：对 Web 静态产物与 server 源做 secret 指纹扫描。
# 退出码：0 = 干净；1 = 命中（fail closed）。CI 门见 .github/workflows/typescript.yml。
# 模式分两档：结构化模式（带分隔符，minified JS 压缩变量撞不成此形状）全量扫；
# 定宽模式（AKIA/AIza）只扫文本类资产——实测 monaco bundle 压缩标识符会误报
# AKIA 定宽串，不进 bundle 扫描面。
set -euo pipefail
cd "$(dirname "$0")/../.." # 仓库根（本脚本在 scripts/release/ 下）

fail=0
STRUCTURED_PATTERNS=(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'gh[pousr]_[0-9A-Za-z]{36,}'
  'sk-ant-[0-9A-Za-z_-]{20,}'
)
TEXT_ONLY_PATTERNS=(
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
)

scan() {
  local label="$1" dir="$2" mode="$3"
  local patterns=("${STRUCTURED_PATTERNS[@]}")
  if [[ "$mode" != "minified" ]]; then patterns+=("${TEXT_ONLY_PATTERNS[@]}"); fi
  local pattern hits
  for pattern in "${patterns[@]}"; do
    hits=$(grep -rInE "$pattern" "$dir" 2>/dev/null | grep -v '\.map$' | head -5 || true)
    if [[ -n "$hits" ]]; then
      echo "SECRET AUDIT HIT [$label] pattern=$pattern"
      echo "$hits"
      fail=1
    fi
  done
}

# 1) Web 静态产物（存在才扫；无产物 = 本地最小构建，跳过不失败）
if [[ -d apps/web/out ]]; then
  scan "web-bundle" apps/web/out minified
else
  echo "secret-audit: apps/web/out absent, skipped"
fi

# 2) web-server 源码
scan "web-server-src" packages/web-server/src text

# 3) dist（若已构建）
if [[ -d packages/web-server/dist ]]; then
  scan "web-server-dist" packages/web-server/dist text
fi

if [[ "$fail" -ne 0 ]]; then
  echo "secret-audit: FAILED (see hits above)"
  exit 1
fi
echo "secret-audit: clean"
