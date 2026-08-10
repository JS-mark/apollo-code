import type { AppIdentity } from './app-identity'

/** Unbundled source-mode identity. Production bundles replace this module at build time. */
export const buildIdentity: AppIdentity = { version: '0.0.0-dev+source', channel: 'source' }
