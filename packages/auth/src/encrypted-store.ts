import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { argon2id } from 'hash-wasm'

import type { CredentialStore } from './index'
interface Envelope {
  v: 1
  salt: string
  iv: string
  tag: string
  ciphertext: string
}
interface LockState {
  attempts: number
  lockedUntil?: number
}
const derive = async (password: string, salt: Uint8Array) =>
  Buffer.from(
    await argon2id({
      password,
      salt,
      parallelism: 2,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    }),
  )
export class EncryptedCredentialStore implements CredentialStore {
  #values: Record<string, string> | undefined
  constructor(
    readonly path: string,
    readonly passphrase: () => Promise<string>,
    readonly statePath = `${path}.state.json`,
  ) {}
  async get(provider: string) {
    await this.unlock()
    return this.#values![provider]
  }
  async set(provider: string, value: string) {
    await this.unlock()
    this.#values![provider] = value
    await this.save()
  }
  async delete(provider: string) {
    await this.unlock()
    delete this.#values![provider]
    await this.save()
  }
  private async unlock() {
    if (this.#values) return
    const state = await this.readState()
    if (state.lockedUntil && state.lockedUntil > Date.now())
      throw new Error('Encrypted credential store is locked')
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#values = {}
        return
      }
      throw error
    }
    try {
      const env = JSON.parse(raw) as Envelope,
        key = await derive(await this.passphrase(), Buffer.from(env.salt, 'base64')),
        decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'))
      this.#values = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(env.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      ) as Record<string, string>
      await this.writeState({ attempts: 0 })
    } catch (error) {
      const attempts = state.attempts + 1,
        lockedUntil = attempts >= 20 ? Date.now() + 86_400_000 : undefined
      await this.writeState({ attempts, ...(lockedUntil ? { lockedUntil } : {}) })
      if (attempts >= 3 && !lockedUntil)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2 ** (attempts - 3) * 100, 5000)),
        )
      throw new Error('Unable to unlock encrypted credential store', { cause: error })
    }
  }
  private async save() {
    const salt = randomBytes(16),
      iv = randomBytes(12),
      key = await derive(await this.passphrase(), salt),
      cipher = createCipheriv('aes-256-gcm', key, iv),
      ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(this.#values), 'utf8'),
        cipher.final(),
      ]),
      env: Envelope = {
        v: 1,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(env), { mode: 0o600 })
    await rename(temp, this.path)
  }
  private async readState(): Promise<LockState> {
    try {
      return JSON.parse(await readFile(this.statePath, 'utf8')) as LockState
    } catch {
      return { attempts: 0 }
    }
  }
  private async writeState(state: LockState) {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 })
    await writeFile(this.statePath, JSON.stringify(state), { mode: 0o600 })
  }
}
