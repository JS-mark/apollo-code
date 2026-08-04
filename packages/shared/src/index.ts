export type JsonPrimitive = boolean | null | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface Logger {
  debug(message: string, context?: Record<string, JsonValue>): void
  error(message: string, context?: Record<string, JsonValue>): void
  info(message: string, context?: Record<string, JsonValue>): void
  warn(message: string, context?: Record<string, JsonValue>): void
}

export class ApolloError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: JsonValue,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ApolloError'
  }
}

export { validateWorkspacePath } from './path-guard'
export { sanitize } from './sanitize'
export * from './errors'
export * from './protocol'
