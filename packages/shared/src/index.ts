export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface Logger {
  debug(message: string, context?: Record<string, JsonValue>): void
  error(message: string, context?: Record<string, JsonValue>): void
  info(message: string, context?: Record<string, JsonValue>): void
  warn(message: string, context?: Record<string, JsonValue>): void
}

export { VolundError } from './errors'
export { validateWorkspacePath } from './path-guard'
export { productIdentity, type ProductIdentity } from './product-identity'
export { sanitize } from './sanitize'
export {
  detectSecret,
  isCredentialKeyForSecretDetection,
  normalizeForSecretDetection,
  type SecretDetection,
  type SecretKind,
} from './secret-detector'
export * from './agent-schema'
export * from './attachments'
export * from './config-schema'
export * from './diff'
export * from './error-codes'
export * from './errors'
export * from './events'
export * from './file-lock'
export * from './i18n'
export * from './ui-copy'
export * from './protocol'
export * from './tasks-schema'
