import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import type { ApolloPorts } from './ports.js'
export interface DoctorCheck { detail: string; name: string; ok: boolean }
export async function runDoctor(cwd: string, ports: ApolloPorts): Promise<DoctorCheck[]> {
  const [native, auth, config] = await Promise.all([ports.native.health(), ports.auth.health(), ports.config.health()])
  let writable = true
  try { await access(cwd, constants.W_OK) } catch { writable = false }
  return [
    { name: 'node version', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.versions.node },
    { name: 'apollo version', ok: true, detail: ports.version },
    { name: 'native sandbox', ok: native.sandbox, detail: native.sandbox ? 'available' : 'native sandbox unavailable' },
    { name: 'native search', ok: native.search, detail: native.search ? 'available' : 'native search unavailable' },
    { name: 'native fs', ok: native.fs, detail: native.fs ? 'available' : 'native fs unavailable' },
    { name: 'auth', ok: auth.configured === true, detail: auth.detail },
    { name: 'config', ok: config.valid === true, detail: config.detail },
    { name: 'cwd writable', ok: writable, detail: cwd },
  ]
}
