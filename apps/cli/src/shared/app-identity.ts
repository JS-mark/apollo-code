export interface AppIdentity {
  version: string
  commit?: string
  channel?: string
  builtAt?: string
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function defineAppIdentity(input: AppIdentity): Readonly<AppIdentity> {
  if (!semverPattern.test(input.version))
    throw new Error(`Invalid Apollo version: ${input.version}`)
  if (input.version === '0.0.0') throw new Error('Apollo production identity cannot use 0.0.0')
  return Object.freeze({ ...input })
}

export const appIdentity = defineAppIdentity(buildIdentity)
import { buildIdentity } from './build-identity'
