/**
 * 内置插件 .volund 打包（r1.6）：rolldown 先产出 dist/plugins/<name>/ 中间目录
 * （已编译 .mjs + main 改写），本脚本把每个目录打成 dist/plugins/<name>.volund
 * 并删除中间目录。运行时 loadBuiltinPlugins 扫 *.volund 解包缓存装载——
 * 覆盖 .volund 文件即完成内置插件更新。无插件目录（源码未随提交）时静默跳过。
 */
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const distPlugins = fileURLToPath(new URL('../dist/plugins/', import.meta.url))
const { buildVolundArchive } = await import(
  new URL('../dist/plugin-archive.mjs', import.meta.url).href
)

const entries = await readdir(distPlugins, { withFileTypes: true }).catch((error) => {
  if (error?.code === 'ENOENT') return []
  throw error
})
let packed = 0
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const dir = join(distPlugins, entry.name)
  const pack = await buildVolundArchive(dir)
  const out = join(distPlugins, `${pack.manifest.name}.volund`)
  await writeFile(out, pack.bytes)
  await rm(dir, { recursive: true, force: true })
  packed++
  console.log(`packed ${entry.name} -> ${pack.manifest.name}.volund (${pack.sha256.slice(0, 12)})`)
}
console.log(`builtin plugins packed: ${packed}`)
