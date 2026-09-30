// P7-01：把 Web 控制台静态产物（apps/web/out，Next 静态导出）收编进
// apps/cli/dist/web-assets——package.json files 已含 dist，随 npm 包分发；
// standalone 侧由 build-standalone.mjs 从 apps/web/out 直接复制（同一来源）。
// 源缺失（本地最小构建）时静默跳过：运行时 webAssetDir() 落到占位页链。
import { access, cp, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// import.meta.dirname = apps/cli/scripts；上三级才是仓库根。
const root = resolve(import.meta.dirname, '../../..')
const source = join(root, 'apps/web/out')
const destination = join(root, 'apps/cli/dist/web-assets')

try {
  await access(source)
} catch {
  console.log('web-assets: apps/web/out not found; skipping (placeholder page at runtime)')
  process.exit(0)
}

await cp(source, destination, { recursive: true })
// 非空 + 带 index.html 才算有效产物：空壳等于把占位页固化进发布包。
const entries = await readdir(destination)
const hasIndex = entries.includes('index.html')
if (!hasIndex) {
  await rm(destination, { recursive: true, force: true })
  throw new Error('apps/web/out is missing index.html; run `pnpm --filter @volund/web build` first')
}
const info = await stat(destination)
console.log(
  `web-assets: packed apps/web/out -> apps/cli/dist/web-assets (${entries.length} entries, ${info.isDirectory() ? 'dir ok' : 'unexpected'})`,
)
