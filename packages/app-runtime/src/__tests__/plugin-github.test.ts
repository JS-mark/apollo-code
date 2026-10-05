import { createHash, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildDetachedSignaturePreimage } from '@volund/capability-contract/authority'
import { PluginError } from '@volund/plugin-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildVolundArchive } from '../plugin-archive'
import {
  installFromGithub,
  isNewerVersion,
  parseGithubPluginSpec,
  pinPluginPublisher,
  PLUGIN_ARCHIVE_SIGNATURE_ROLE,
  readGithubSourceMetadata,
  readPluginTrustStore,
  resolveGithubLatestVersion,
  versionFromAssetName,
} from '../plugin-github'
import { upgradePlugins } from '../plugin-upgrade'

const VOLUND_VERSION = '0.2.0'
const SOURCE = 'github:acme/volund-plugin-githuby'
const LATEST_URL = `https://api.github.com/repos/acme/volund-plugin-githuby/releases/latest`

function makeSigner(): { keyBase64Url: string; sign(payload: Uint8Array): Uint8Array } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  return {
    keyBase64Url: der.subarray(der.length - 32).toString('base64url'),
    sign: (payload) => new Uint8Array(ed25519Sign(null, payload, privateKey)),
  }
}

function signatureEnvelope(signed: Uint8Array, signer: ReturnType<typeof makeSigner>): Uint8Array {
  const signature = signer.sign(
    buildDetachedSignaturePreimage(PLUGIN_ARCHIVE_SIGNATURE_ROLE, signed),
  )
  const envelope = {
    algorithm: 'ed25519',
    keyId: 'test-key',
    signatureBase64Url: Buffer.from(signature).toString('base64url'),
    signedSchemaRole: PLUGIN_ARCHIVE_SIGNATURE_ROLE,
    version: 1,
  }
  return new TextEncoder().encode(JSON.stringify(envelope))
}

async function buildPluginArchive(version: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'volund-githuby-src-'))
  try {
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'volund-plugin-githuby',
        version,
        type: 'module',
        main: 'index.js',
        engines: { volund: '^0.2.0' },
        permissions: { volund: ['tools.register'] },
      }),
    )
    await writeFile(join(dir, 'index.js'), 'export async function activate() {}')
    return (await buildVolundArchive(dir)).bytes
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface ReleaseFile {
  readonly name: string
  readonly bytes: Uint8Array
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** release JSON + 全部资产 URL 的 fetch 桩：API 命中 apiUrls，资产走 example.test。 */
function stubGithubFetch(files: readonly ReleaseFile[], apiUrls: readonly string[]): void {
  const byUrl = new Map<string, Uint8Array>(
    files.map((file) => [`https://example.test/${file.name}`, file.bytes]),
  )
  for (const apiUrl of apiUrls) {
    byUrl.set(
      apiUrl,
      new TextEncoder().encode(
        JSON.stringify({
          tag_name: 'v1.1.0',
          assets: files.map((file) => ({
            name: file.name,
            browser_download_url: `https://example.test/${file.name}`,
            size: file.bytes.byteLength,
          })),
        }),
      ),
    )
  }
  const fetchStub = async (url: string | URL): Promise<Response> => {
    const body = byUrl.get(String(url))
    if (body === undefined) return new Response(null, { status: 404 })
    return new Response(body as never, {
      status: 200,
      headers: { 'content-length': String(body.byteLength) },
    })
  }
  vi.stubGlobal('fetch', fetchStub)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseGithubPluginSpec', () => {
  it('github:owner/repo、@tag、.git 后缀；非法形态 undefined', () => {
    expect(parseGithubPluginSpec('github:acme/repo')).toEqual({ owner: 'acme', repo: 'repo' })
    expect(parseGithubPluginSpec('github:acme/repo@v1.0.0')).toEqual({
      owner: 'acme',
      repo: 'repo',
      tag: 'v1.0.0',
    })
    expect(parseGithubPluginSpec('github:acme/repo.git')).toEqual({ owner: 'acme', repo: 'repo' })
    expect(parseGithubPluginSpec('github:acme')).toBeUndefined()
    expect(parseGithubPluginSpec('github:acme/repo/extra')).toBeUndefined()
    expect(parseGithubPluginSpec('https://github.com/acme/repo')).toBeUndefined()
  })
})

describe('isNewerVersion / versionFromAssetName', () => {
  it('数值三元组 + prerelease 语义；垃圾输入一律 false', () => {
    expect(isNewerVersion('1.2.3', '1.2.2')).toBe(true)
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
    // semver：更高三元组的 prerelease 仍高于低版本；同三元组下 release > prerelease。
    expect(isNewerVersion('1.2.4-rc.1', '1.2.3')).toBe(true)
    expect(isNewerVersion('1.2.3', '1.2.4-rc.1')).toBe(false)
    expect(isNewerVersion('1.2.4-rc.1', '1.2.4')).toBe(false)
    expect(isNewerVersion('1.2.4', '1.2.4-rc.1')).toBe(true)
    expect(isNewerVersion('nonsense', '1.0.0')).toBe(false)
  })

  it('资产名尾段 semver 解析', () => {
    expect(versionFromAssetName('volund-plugin-x-1.2.3.volund')).toBe('1.2.3')
    expect(versionFromAssetName('volund-plugin-x-1.2.3-beta.1.volund')).toBe('1.2.3-beta.1')
    expect(versionFromAssetName('volund-plugin-x.volund')).toBeUndefined()
  })
})

describe('installFromGithub', () => {
  it('钉钥 + 签名验讫 → 安装进 plugins-dev 并写 volund-source.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-github-home-'))
    const signer = makeSigner()
    await pinPluginPublisher(home, SOURCE, signer.keyBase64Url)
    const archive = await buildPluginArchive('1.0.0')
    const files: ReleaseFile[] = [
      { name: 'volund-plugin-githuby-1.0.0.volund', bytes: archive },
      {
        name: 'volund-plugin-githuby-1.0.0.volund.sig',
        bytes: signatureEnvelope(archive, signer),
      },
      {
        name: 'volund-plugin-githuby-1.0.0.volund.sha256',
        bytes: new TextEncoder().encode(
          `${sha256Hex(archive)}  volund-plugin-githuby-1.0.0.volund\n`,
        ),
      },
    ]
    stubGithubFetch(files, [LATEST_URL])
    try {
      const result = await installFromGithub({
        home,
        spec: SOURCE,
        volundVersion: VOLUND_VERSION,
      })
      expect(result.name).toBe('volund-plugin-githuby')
      expect(result.version).toBe('1.0.0')
      expect(result.tag).toBe('v1.1.0')
      expect(result.dir).toContain(join('plugins-dev', 'volund-plugin-githuby'))
      const metadata = await readGithubSourceMetadata(result.dir)
      expect(metadata?.source).toBe(SOURCE)
      expect(metadata?.tag).toBe('v1.1.0')
      await readFile(join(result.dir, 'index.js'))
      const store = await readPluginTrustStore(home)
      expect(store.publishers[SOURCE]?.ed25519).toBe(signer.keyBase64Url)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('未钉发布者 → plugin_registry_signature_required（fail closed）', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-github-home-'))
    const signer = makeSigner()
    const archive = await buildPluginArchive('1.0.0')
    const files: ReleaseFile[] = [
      { name: 'volund-plugin-githuby-1.0.0.volund', bytes: archive },
      {
        name: 'volund-plugin-githuby-1.0.0.volund.sig',
        bytes: signatureEnvelope(archive, signer),
      },
    ]
    stubGithubFetch(files, [LATEST_URL])
    try {
      await expect(
        installFromGithub({ home, spec: SOURCE, volundVersion: VOLUND_VERSION }),
      ).rejects.toMatchObject({ code: 'plugin_registry_signature_required' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('缺 .sig 资产 → signature_required；钉错钥 → signature_invalid', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-github-home-'))
    try {
      const signer = makeSigner()
      const impostor = makeSigner()
      await pinPluginPublisher(home, SOURCE, impostor.keyBase64Url)
      const archive = await buildPluginArchive('1.0.0')
      const unsigned: ReleaseFile[] = [
        { name: 'volund-plugin-githuby-1.0.0.volund', bytes: archive },
      ]
      stubGithubFetch(unsigned, [LATEST_URL])
      await expect(
        installFromGithub({ home, spec: SOURCE, volundVersion: VOLUND_VERSION }),
      ).rejects.toMatchObject({ code: 'plugin_registry_signature_required' })

      const signed: ReleaseFile[] = [
        { name: 'volund-plugin-githuby-1.0.0.volund', bytes: archive },
        {
          name: 'volund-plugin-githuby-1.0.0.volund.sig',
          bytes: signatureEnvelope(archive, signer),
        },
      ]
      stubGithubFetch(signed, [LATEST_URL])
      await expect(
        installFromGithub({ home, spec: SOURCE, volundVersion: VOLUND_VERSION }),
      ).rejects.toMatchObject({ code: 'plugin_registry_signature_invalid' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('sha256 sidecar 与内容不符 → plugin_registry_digest_mismatch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-github-home-'))
    const signer = makeSigner()
    await pinPluginPublisher(home, SOURCE, signer.keyBase64Url)
    const archive = await buildPluginArchive('1.0.0')
    const files: ReleaseFile[] = [
      { name: 'volund-plugin-githuby-1.0.0.volund', bytes: archive },
      {
        name: 'volund-plugin-githuby-1.0.0.volund.sig',
        bytes: signatureEnvelope(archive, signer),
      },
      {
        name: 'volund-plugin-githuby-1.0.0.volund.sha256',
        bytes: new TextEncoder().encode(`${'0'.repeat(64)}  volund-plugin-githuby-1.0.0.volund\n`),
      },
    ]
    stubGithubFetch(files, [LATEST_URL])
    try {
      await expect(
        installFromGithub({ home, spec: SOURCE, volundVersion: VOLUND_VERSION }),
      ).rejects.toMatchObject({ code: 'plugin_registry_digest_mismatch' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('upgradePlugins', () => {
  it('github 通道：有新版本 → upgraded 并刷新 volund-source.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-upgrade-home-'))
    const signer = makeSigner()
    await pinPluginPublisher(home, SOURCE, signer.keyBase64Url)
    // 已安装 0.9.0（volund-source.json），远端最新 1.0.0。
    const devDir = join(home, 'plugins-dev', 'volund-plugin-githuby')
    await mkdir(devDir, { recursive: true })
    await writeFile(
      join(devDir, 'volund-source.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'volund-plugin-githuby',
        version: '0.9.0',
        source: SOURCE,
        tag: 'v0.9.0',
        installedAt: '2026-10-05T00:00:00.000Z',
      }),
    )
    const archive = await buildPluginArchive('1.0.0')
    const files: ReleaseFile[] = [
      { name: 'volund-plugin-githuby-1.0.0.volund', bytes: archive },
      {
        name: 'volund-plugin-githuby-1.0.0.volund.sig',
        bytes: signatureEnvelope(archive, signer),
      },
    ]
    stubGithubFetch(files, [LATEST_URL])
    try {
      const rows = await upgradePlugins({ home, volundVersion: VOLUND_VERSION })
      const githubRow = rows.find((row) => row.channel === 'github')
      expect(githubRow).toMatchObject({
        name: 'volund-plugin-githuby',
        from: '0.9.0',
        to: '1.0.0',
        status: 'upgraded',
      })
      expect((await readGithubSourceMetadata(devDir))?.version).toBe('1.0.0')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('unknown 名单 → unresolved 可发现性行', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-upgrade-empty-'))
    try {
      const rows = await upgradePlugins({
        home,
        volundVersion: VOLUND_VERSION,
        names: ['volund-plugin-ghost'],
      })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ name: 'volund-plugin-ghost', status: 'unresolved' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('本地安装静默跳过；资产名无 semver 时探测只回 tag', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-upgrade-local-'))
    const devDir = join(home, 'plugins-dev', 'volund-plugin-local')
    await mkdir(devDir, { recursive: true })
    await writeFile(join(devDir, 'index.js'), 'export async function activate() {}')
    try {
      const rows = await upgradePlugins({ home, volundVersion: VOLUND_VERSION })
      expect(rows).toHaveLength(0)
      stubGithubFetch([], [`https://api.github.com/repos/acme/empty/releases/latest`])
      const latest = await resolveGithubLatestVersion({ spec: 'github:acme/empty' })
      expect(latest).toEqual({ tag: 'v1.1.0' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('trust store', () => {
  it('pin 后读回一致；非法 key 拒绝', async () => {
    const home = await mkdtemp(join(tmpdir(), 'volund-trust-home-'))
    try {
      const signer = makeSigner()
      await pinPluginPublisher(home, SOURCE, signer.keyBase64Url)
      const store = await readPluginTrustStore(home)
      expect(store.publishers[SOURCE]?.ed25519).toBe(signer.keyBase64Url)
      await expect(pinPluginPublisher(home, SOURCE, 'not-a-key')).rejects.toBeInstanceOf(
        PluginError,
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
