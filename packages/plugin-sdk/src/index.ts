export interface Disposable {
  dispose(): void | Promise<void>
}
export interface PluginManifest {
  name: `apollo-plugin-${string}`
  version: string
  engines: { apollo: string }
  main: string
  type: 'module'
  contributes?: Record<string, readonly string[]>
  permissions: {
    fs?: { read?: readonly string[]; write?: readonly string[] }
    bash?: { allowlist: readonly string[] }
    net?: false | { allowlist: readonly string[] }
    apollo: readonly string[]
  }
}
export interface ApolloBridge {
  readonly apiVersion: '1.0'
  readonly plugin: { name: string; version: string; dataDir: string }
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}
export interface ApolloPlugin {
  activate(apollo: ApolloBridge): void | Promise<void>
  deactivate?(): void | Promise<void>
}
export const definePlugin = <T extends ApolloPlugin>(plugin: T): T => plugin
export const defineTool = <T>(tool: T): T => tool
