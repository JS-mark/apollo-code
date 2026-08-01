import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const root = resolve(dirname(scriptPath), '..')
const sourceRoots = ['apps', 'packages']
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts'])

export function relativeSpecifierError(sourcePath, specifier, fileExists = existsSync) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined

  const extension = extname(specifier)
  if (['.js', '.mjs', '.cjs'].includes(extension))
    return `uses emitted extension ${extension}; source imports must name their TypeScript extension`
  if (extension === '.json') return undefined
  if (!sourceExtensions.has(extension)) return 'has no supported TypeScript source extension'

  const target = resolve(dirname(sourcePath), specifier)
  if (!fileExists(target)) {
    return `does not map to a source file (${relative(root, target)})`
  }
  return undefined
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === 'dist' || entry.name === 'node_modules' ? [] : walk(path)
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  })
}

function sourceSpecifiers(path) {
  const source = readFileSync(path, 'utf8')
  const specifiers = new Set()
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return specifiers
}

function workspaceDirectories() {
  return sourceRoots.flatMap((sourceRoot) => {
    const directory = join(root, sourceRoot)
    if (!existsSync(directory)) return []
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json')),
      )
      .map((entry) => join(directory, entry.name))
  })
}

export function outDirError(outDir) {
  if (!outDir) return 'has no effective compilerOptions.outDir'
  if (outDir === 'dist' || outDir === './dist') return undefined
  return `must emit to its own dist directory (received ${outDir})`
}

export function auditRepository() {
  const errors = []
  for (const workspace of workspaceDirectories()) {
    const configPath = join(workspace, 'tsconfig.json')
    if (!existsSync(configPath)) continue
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const error = outDirError(config.compilerOptions?.outDir)
    if (error) errors.push(`${relative(root, configPath)}: ${error}`)
  }

  for (const sourceRoot of sourceRoots) {
    const directory = join(root, sourceRoot)
    if (!existsSync(directory)) continue
    for (const path of walk(directory)) {
      for (const specifier of sourceSpecifiers(path)) {
        const error = relativeSpecifierError(path, specifier)
        if (error) errors.push(`${relative(root, path)}: ${specifier}: ${error}`)
      }
    }
  }
  return errors
}

if (isAbsolute(process.argv[1] ?? '') && resolve(process.argv[1]) === scriptPath) {
  const errors = auditRepository()
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else {
    console.log('TypeScript config and relative ESM specifiers are valid.')
  }
}
