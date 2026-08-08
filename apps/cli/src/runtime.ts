import {
  access,
  appendFile,
  glob,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { AuthManager, EncryptedCredentialStore } from '@apollo-code/auth'
import { parseTomlFile } from '@apollo-code/config'
import { SlidingWindowPolicy } from '@apollo-code/context'
import {
  builtinPromptFragment,
  createSession,
  DefaultPromptComposer,
  EventBus,
  MachineEventFormatter,
  EvolutionEngine,
  Runner,
  updateSession,
  wrapUntrusted,
} from '@apollo-code/core'
import type { RunnerToolPort, SessionState } from '@apollo-code/core'
import { execSandbox, probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import { PermissionManager } from '@apollo-code/permission'
import type { PermissionDecision, PermissionRequest } from '@apollo-code/permission'
import { BridgeRuntime, PluginManager, PluginRuntime } from '@apollo-code/plugin-runtime'
import type { ToolSpec } from '@apollo-code/plugin-sdk'
import { AnthropicClient, verifyAnthropicCredential } from '@apollo-code/provider-anthropic'
import type { HttpPort, HttpRequest, HttpResponse } from '@apollo-code/provider-anthropic'
import { InMemoryProviderRegistry } from '@apollo-code/provider-kit'
import { parseRoleRouterConfig, RoleRouter, SingleProviderRouter } from '@apollo-code/router'
import type { RouterPolicy } from '@apollo-code/router'
import { sanitize, type JsonValue } from '@apollo-code/shared'
import { SkillsRuntime } from '@apollo-code/skills-runtime'
import {
  AttachmentStore,
  BackupStore,
  EvolutionStore,
  PromptLoader,
  SessionStore,
} from '@apollo-code/storage'
import { SubagentDispatcher } from '@apollo-code/subagent'
import {
  LocalTelemetrySink,
  Telemetry,
  TelemetryLogger,
  TelemetryStore,
} from '@apollo-code/telemetry'
import { ToolRegistry } from '@apollo-code/tool-kit'
import { builtinTools, ToolExecutor } from '@apollo-code/tools'
import { renderInteractiveApp } from '@apollo-code/ui'
import type {
  InteractivePermissionDecision,
  InteractivePermissionRequest,
  SubmitOptions,
} from '@apollo-code/ui'
import { v7 as uuidv7 } from 'uuid'

import type { ApolloPorts, SessionPort } from './ports'

export type RunnerFactory = (state: SessionState, events: EventBus) => Runner | Promise<Runner>
const terminalStatuses = new Set(['done', 'aborted', 'error'])
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const historySecretPattern =
  /\b(?:authorization|api[_-]?key|token|secret|passphrase|password|oauth[_-]?code|anthropic[_-]?api[_-]?key|openai[_-]?api[_-]?key)\b/i

export class RuntimeSessionPort implements SessionPort {
  #runner: Runner | undefined
  #events: EventBus | undefined
  #store: SessionStore | undefined
  #output?: { json: boolean; write: (value: string) => void }
  #lastExitCode = 0
  constructor(
    readonly sessionsDir: string,
    readonly createRunner: RunnerFactory,
    readonly onSecurity?: (input: { skipPermissions: boolean }) => void,
    readonly onEnd?: (sessionId: string) => void | Promise<void>,
    readonly onTerminalOutput?: (input: { streamToStdout: boolean }) => void,
    readonly onPermissionPromptHandler?: (
      handler:
        | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
        | undefined,
    ) => void,
  ) {}
  configureSecurity(input: { skipPermissions: boolean }): void {
    this.onSecurity?.(input)
  }
  configureOutput(input: { json: boolean; write: (value: string) => void }): void {
    this.#output = input
  }
  configureTerminalOutput(input: { streamToStdout: boolean }): void {
    this.onTerminalOutput?.(input)
  }
  async start(input: { cwd: string; prompt?: string }): Promise<{ id: string; exitCode?: number }> {
    const session = await this.startInteractive({ cwd: input.cwd })
    if (input.prompt !== undefined) {
      await this.#runner!.run(input.prompt)
      await this.snapshot()
    } else {
      if (!isInteractiveTerminal()) throw new Error('Interactive chat requires a TTY or a prompt')
      for (;;) {
        const prompt = await promptLineMaybe('> ')
        if (prompt === undefined) break
        const trimmed = prompt.trim()
        if (!trimmed) continue
        if (trimmed === 'exit' || trimmed === 'quit') break
        await this.#runner!.run(prompt)
        await this.snapshot()
      }
      await this.snapshot()
      await session.end()
    }
    return { id: session.id, exitCode: session.exitCode() }
  }
  async startInteractive(input: { cwd: string }) {
    const id = uuidv7()
    await this.activate(
      createSession({ id, cwd: input.cwd, maxTokens: 200_000, toolRegistrySnapshot: 'builtin:l1' }),
      false,
    )
    return {
      id,
      events: this.#events!,
      setPermissionPromptHandler: (
        handler:
          | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
          | undefined,
      ) => {
        this.onPermissionPromptHandler?.(handler)
      },
      submit: async (prompt: string, submitOptions?: SubmitOptions) => {
        await this.#runner!.run(
          prompt,
          submitOptions?.model ? { explicitModel: submitOptions.model } : undefined,
        )
        await this.snapshot()
      },
      end: async () => {
        await this.end()
      },
      exitCode: () => {
        const last = this.#runner?.state.turns.at(-1)
        if (!this.#runner) return this.#lastExitCode
        return last?.status === 'aborted' ? this.#lastExitCode : 0
      },
    }
  }
  async resume(id: string): Promise<{ id: string }> {
    if (!sessionIdPattern.test(id)) throw new Error('Invalid session id')
    const store = new SessionStore(this.path(id))
    const entries = await store.resume(20)
    const snapshot = entries.findLast((entry) => entry.type === 'session.snapshot')
    if (!snapshot) throw new Error(`Session not found or has no resumable snapshot: ${id}`)
    const restored = snapshot.payload as unknown as SessionState
    const state = updateSession(restored, (draft) => {
      draft.activeTurn = null
      draft.pendingInterrupt = false
      draft.turns = draft.turns.map((turn) =>
        terminalStatuses.has(turn.status) ? turn : { ...turn, status: 'aborted' },
      )
    })
    await this.activate(state, true)
    await this.snapshot()
    return { id }
  }
  async interrupt(): Promise<void> {
    this.#runner?.interrupt()
    await this.snapshot()
  }
  async end(): Promise<void> {
    if (!this.#runner || !this.#events) return
    const sessionId = this.#runner.state.id
    await this.#events.emit({
      type: 'session.ended',
      version: this.#runner.state.version,
      sessionId: this.#runner.state.id,
      payload: {},
    })
    await this.snapshot()
    await this.onEnd?.(sessionId)
    this.onPermissionPromptHandler?.(undefined)
    this.#runner = undefined
    this.#events = undefined
    this.#store = undefined
  }
  private path(id: string): string {
    return join(this.sessionsDir, `${id}.jsonl`)
  }
  private async activate(state: SessionState, resumed: boolean): Promise<void> {
    const events = new EventBus()
    this.#lastExitCode = 0
    const store = new SessionStore(this.path(state.id))
    store.attach(events)
    events.subscribe((event) => {
      if (event.type !== 'turn.aborted') return
      const exitCode = (event.payload as { exitCode?: unknown }).exitCode
      this.#lastExitCode = typeof exitCode === 'number' ? exitCode : 130
    })
    if (this.#output?.json) {
      const formatter = new MachineEventFormatter()
      events.subscribe((event) => {
        const line = formatter.encode(event)
        if (line) this.#output?.write(line)
      })
    }
    this.#events = events
    this.#store = store
    this.#runner = await this.createRunner(state, events)
    await events.emit({
      type: resumed ? 'session.resumed' : 'session.started',
      version: state.version,
      sessionId: state.id,
      payload: resumed ? { tailTurns: 20 } : { cwd: state.cwd },
    })
  }
  private async snapshot(): Promise<void> {
    if (!this.#runner || !this.#store) return
    const state = JSON.parse(JSON.stringify(this.#runner.state)) as JsonValue
    await this.#store.append({
      v: 1,
      id: uuidv7(),
      type: 'session.snapshot',
      sessionId: this.#runner.state.id,
      at: new Date().toISOString(),
      payload: state,
    })
  }
}

export class FileInputHistoryStore {
  constructor(
    readonly path: string,
    readonly maxBytes = 1024 * 1024,
    readonly maxEntries = 1000,
    readonly maxInputBytes = 8 * 1024,
  ) {}

  async append(input: string): Promise<void> {
    const value = input.trim()
    if (!this.storeable(value)) return
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    await appendFile(
      this.path,
      `${JSON.stringify({ at: new Date().toISOString(), input: value })}\n`,
      { mode: 0o600 },
    )
    await this.compact()
  }

  async list(): Promise<readonly string[]> {
    return (await this.records()).map((record) => record.input)
  }

  private storeable(input: string): boolean {
    if (!input) return false
    if (Buffer.byteLength(input, 'utf8') > this.maxInputBytes) return false
    if (historySecretPattern.test(input)) return false
    return sanitize(input) === input
  }

  private async compact(): Promise<void> {
    let records = (await this.records()).slice(-this.maxEntries)
    let serialized = serializeHistory(records)
    while (records.length > 0 && Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      records = records.slice(1)
      serialized = serializeHistory(records)
    }
    const temp = `${this.path}.${process.pid}.tmp`
    await writeFile(temp, serialized, { mode: 0o600 })
    await rename(temp, this.path)
  }

  private async records(): Promise<Array<{ at: string; input: string }>> {
    try {
      const text = await readFile(this.path, 'utf8')
      return text
        .split('\n')
        .flatMap((line) => {
          if (!line) return []
          try {
            const record = JSON.parse(line) as { at?: unknown; input?: unknown }
            if (typeof record.input !== 'string') return []
            return [{ at: typeof record.at === 'string' ? record.at : '', input: record.input }]
          } catch {
            return []
          }
        })
        .filter((record) => this.storeable(record.input))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

function serializeHistory(records: readonly { at: string; input: string }[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
}

export class NodeHttpPort implements HttpPort {
  async request(input: HttpRequest): Promise<HttpResponse> {
    const url = new URL(input.url)
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        url,
        { method: input.method, headers: input.headers, signal: input.signal },
        (response) => {
          const headers = Object.fromEntries(
            Object.entries(response.headers).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value]],
            ),
          )
          resolve({ status: response.statusCode ?? 0, headers, body: response })
        },
      )
      req.once('error', reject)
      req.end(input.method === 'GET' ? undefined : JSON.stringify(input.body))
    })
  }
}

async function promptLine(question: string): Promise<string> {
  return (await promptLineMaybe(question)) ?? ''
}
function isInteractiveTerminal(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}
async function promptLineMaybe(question: string): Promise<string | undefined> {
  if (!isInteractiveTerminal()) return undefined
  const io = createInterface({ input: stdin, output: stdout })
  try {
    return await io.question(question)
  } catch {
    return undefined
  } finally {
    io.close()
  }
}
async function promptSecret(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) return ''
  stdout.write(question)
  stdin.setRawMode(true)
  stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (error?: Error) => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new Error('Credential input was cancelled'))
        if (byte === 13 || byte === 10) return finish()
        if (byte === 8 || byte === 127) value = value.slice(0, -1)
        else if (byte >= 32) value += String.fromCharCode(byte)
      }
    }
    stdin.on('data', onData)
  })
}
async function permissionPrompt(request: PermissionRequest): Promise<PermissionDecision> {
  const answer = (
    await promptLine(
      `Permission required: ${request.toolName} ${JSON.stringify(request.spec)}\n[a]llow once, allow [s]ession, [d]eny: `,
    )
  )
    .trim()
    .toLowerCase()
  return { kind: answer === 's' ? 'allow-session' : answer === 'a' ? 'allow-once' : 'deny' }
}

async function requestPermission(input: {
  events: EventBus
  interactivePermissionPrompt:
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  request: PermissionRequest
  version: number
}): Promise<PermissionDecision> {
  const id = uuidv7()
  const uiRequest: InteractivePermissionRequest = {
    id,
    attempt: input.request.attempt,
    input: sanitize(input.request.input as JsonValue),
    spec: sanitize(input.request.spec as JsonValue),
    toolName: input.request.toolName,
  }
  await input.events.emit({
    type: 'tool.permission_asked',
    version: input.version,
    sessionId: input.request.session.id,
    payload: uiRequest as unknown as JsonValue,
  })
  if (!input.interactivePermissionPrompt) return permissionPrompt(input.request)
  const decision = await input.interactivePermissionPrompt(uiRequest)
  return { kind: decision.kind }
}

export interface ProductionOptions {
  apolloHome?: string
  model?: string
  version?: string
}
export function createProductionPorts(options: ProductionOptions = {}): ApolloPorts {
  const home = options.apolloHome ?? process.env.APOLLO_HOME ?? join(homedir(), '.apollo')
  const backups = new BackupStore(join(home, 'backups'))
  const evolution = new EvolutionStore(join(home, 'tuning'))
  const history = new FileInputHistoryStore(join(home, 'history', 'input.jsonl'))
  const telemetryPath = join(home, 'telemetry', 'events.jsonl')
  const telemetry = new Telemetry(new LocalTelemetrySink(telemetryPath))
  const telemetryStore = new TelemetryStore(telemetryPath)
  const logger = new TelemetryLogger(telemetry, 'cli')
  const pluginRoot = join(home, 'plugins')
  const plugins = new PluginManager(
    pluginRoot,
    options.version ?? '0.0.0',
    async (manifest, expanded) => {
      const permissions = manifest.permissions.apollo.join(', ') || 'none'
      const answer = await promptLine(
        `${expanded ? 'Expanded' : 'Requested'} plugin permissions for ${manifest.name}: ${permissions}\nApprove? [y/N] `,
      )
      return answer.trim().toLowerCase() === 'y'
    },
  )
  const pluginsReady = plugins.init()
  const pluginRuntimes = new Set<PluginRuntime>()
  let cachedPassphrase: string | undefined
  const passphrase = async () => {
    if (cachedPassphrase) return cachedPassphrase
    const value = await promptSecret('Credential-store passphrase: ')
    if (!value) throw new Error('A credential-store passphrase is required')
    cachedPassphrase = value
    return value
  }
  const encrypted = new EncryptedCredentialStore(
    join(home, 'credentials.enc'),
    passphrase,
    join(home, 'auth.state.json'),
  )
  const auth = new AuthManager({ encrypted, env: process.env, telemetry })
  const http = new NodeHttpPort()
  const permissionOptions: { dangerouslySkip: boolean; logger: TelemetryLogger } = {
    dangerouslySkip: false,
    logger,
  }
  let interactivePermissionPrompt:
    | ((request: InteractivePermissionRequest) => Promise<InteractivePermissionDecision>)
    | undefined
  let streamToStdout = true
  let dispatcher: SubagentDispatcher
  const createRunner: RunnerFactory = async (state, events) => {
    // A manager per Runner is intentional: child sessions cannot inherit parent permission cache.
    const permissions = new PermissionManager({}, permissionOptions)
    permissions.setPromptHandler(async (request) => {
      const decision = await requestPermission({
        events,
        interactivePermissionPrompt,
        request,
        version: state.version,
      })
      if (state.lineage.depth === 0) return decision
      return ['allow-once', 'allow-session', 'deny'].includes(decision.kind)
        ? decision
        : { kind: 'deny' }
    })
    let evolutionEnabled = true
    let userConfig: Record<string, JsonValue> = {}
    try {
      userConfig = await parseTomlFile(join(home, 'config.toml'))
      const section = userConfig.evolution
      if (section && typeof section === 'object' && !Array.isArray(section))
        evolutionEnabled = section.enabled !== false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn('Unable to read evolution config')
    }
    const tuned = await new EvolutionEngine(evolution, { enabled: evolutionEnabled }).values()
    const contextPolicy = new SlidingWindowPolicy({
      compactionThreshold: tuned.compaction_threshold,
      targetRatio: tuned.target_ratio,
      keepRecent: tuned.keep_recent,
    })
    const composer = new DefaultPromptComposer()
    composer.register(builtinPromptFragment)
    const promptLoader = new PromptLoader({ cwd: state.cwd, apolloHome: home, permissions })
    await promptLoader.registerProject(composer)
    const skills = new SkillsRuntime({
      skillsDir: join(home, 'skills'),
      apolloVersion: options.version ?? '0.0.0',
      composer,
      onWarning: (message) => logger.warn(message),
    })
    await skills.discover()
    await skills.registerIndex()
    await skills.activateAutomatic(state.cwd)
    const attachments = new AttachmentStore(
      join(home, 'sessions', state.id, 'attachments'),
      20 * 1024 * 1024,
      [state.cwd],
    )
    const anthropic = new AnthropicClient({
      credentials: {
        async getCredential() {
          const value = await auth.getCredential('anthropic')
          if (!value) throw new Error('Anthropic credential unavailable')
          return value
        },
      },
      http,
      attachments,
    })
    const client = {
      ...anthropic,
      name: anthropic.name,
      capabilities: anthropic.capabilities,
      dispose: () => anthropic.dispose(),
      async *stream(request: Parameters<AnthropicClient['stream']>[0], signal: AbortSignal) {
        for await (const chunk of anthropic.stream(request, signal)) {
          if (streamToStdout && chunk.kind === 'text.delta') stdout.write(chunk.text)
          yield chunk
        }
        if (streamToStdout) stdout.write('\n')
      },
    }
    const providers = new InMemoryProviderRegistry()
    providers.register(
      client,
      { kind: 'core' },
      { capabilities: client.capabilities, displayName: 'Anthropic' },
    )
    let router: RouterPolicy = new SingleProviderRouter(
      client,
      options.model ?? 'claude-sonnet-4-20250514',
      undefined,
      providers,
    )
    const routerConfig = userConfig.router
    if (
      routerConfig &&
      typeof routerConfig === 'object' &&
      !Array.isArray(routerConfig) &&
      routerConfig.type === 'role'
    )
      router = new RoleRouter(providers, parseRoleRouterConfig(routerConfig))
    const registry = new ToolRegistry()
    for (const tool of builtinTools({
      backups,
      task: {
        dispatcher,
        parent: (signal) => ({
          state: runner.state,
          events,
          turnId: runner.state.activeTurn ?? '',
          signal,
        }),
      },
    }))
      registry.register(tool)
    registry.register({
      name: 'Skill.activate',
      description: 'Activate an installed prompt skill for the current session',
      readonly: true,
      parallelSafe: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      permissionSpec: () => ({}),
      async invoke(input: unknown) {
        const name = (input as { name: string }).name
        const activated = await skills.activate(name)
        return {
          content: [
            {
              type: 'text',
              text: activated ? `Activated skill: ${name}` : `Skill already active: ${name}`,
            },
          ],
          meta: { durationMs: 0, costImpact: 'safe' },
        }
      },
    })
    let runner: Runner
    const native = {
      async execute(command: string, args: string[], signal: AbortSignal) {
        const result = await execSandbox(
          {
            command: [command, ...args].join(' '),
            cwd: runner.state.cwd,
            permissions: {
              fs: { read: [runner.state.cwd], write: [runner.state.cwd] },
              net: false,
              env: { read: [] },
            },
          },
          signal,
        )
        for (const reason of result.sandbox_violations) {
          await telemetry.violation({
            mechanism: 'apollo-sandbox',
            tier: result.sandbox_tier,
            operation: 'sandbox-exec',
            decision: 'deny',
            reason,
          })
        }
        return result.stdout
      },
    }
    const executor = new ToolExecutor(permissions, (signal) => ({
      abortSignal: signal,
      session: { id: state.id, cwd: state.cwd, turnId: runner.state.activeTurn ?? '' },
      native,
      logger,
      ui: { requestInput: promptLine },
    }))
    const tools: RunnerToolPort = {
      schemas: () => registry.forProvider(),
      async execute(use, signal) {
        const tool = registry.get(use.name)
        if (!tool)
          return {
            toolUseId: use.id,
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${use.name}` }],
          }
        const result = await executor.execute(tool, use.input, signal)
        return {
          toolUseId: use.id,
          content: result.content,
          ...(result.isError === undefined ? {} : { isError: result.isError }),
        }
      },
    }
    runner = new Runner(state, router, composer, tools, events, {}, contextPolicy)
    await pluginsReady
    const pluginStorage = new Map<string, unknown>()
    const pluginRuntime = new PluginRuntime(
      plugins,
      new BridgeRuntime({
        get session() {
          return {
            id: runner.state.id,
            cwd: runner.state.cwd,
            messages: runner.state.messages,
            usage: {
              inputTokens: runner.state.cumulativeUsage.input,
              outputTokens: runner.state.cumulativeUsage.output,
              cost: runner.state.cumulativeUsage.costUSD,
            },
          }
        },
        register(kind, value, plugin) {
          if (kind !== 'tool') throw new Error(`plugin_${kind}_registration_not_supported`)
          const spec = value as ToolSpec
          const dispose = registry.register(
            {
              name: spec.name,
              description: spec.description,
              inputSchema: spec.inputSchema as never,
              permissionSpec: () => ({}),
              async invoke(input, context) {
                const result = await spec.handler(input, {
                  session: context.session,
                  aborted: context.abortSignal.aborted,
                })
                const content =
                  result &&
                  typeof result === 'object' &&
                  Array.isArray((result as { content?: unknown }).content)
                    ? (result as { content: Array<{ type: 'text'; text: string }> }).content
                    : [
                        {
                          type: 'text' as const,
                          text: typeof result === 'string' ? result : JSON.stringify(result),
                        },
                      ]
                return {
                  content: wrapUntrusted(content, `plugin:${plugin}:${spec.name}`),
                  meta: { durationMs: 0 },
                }
              },
            },
            { kind: 'plugin', plugin },
          )
          return { dispose }
        },
        fs: {
          readFile: (path, encoding) => readFile(path, encoding === 'binary' ? undefined : 'utf8'),
          writeFile,
          exists: async (path) =>
            access(path).then(
              () => true,
              () => false,
            ),
          glob: async (pattern, cwd) => Array.fromAsync(glob(pattern, { cwd })),
          stat: async (path) => {
            const value = await stat(path)
            return {
              size: value.size,
              type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
              modifiedAt: value.mtimeMs,
            }
          },
        },
        exec: async (command, rawOptions, signal) => {
          const execOptions = (rawOptions ?? {}) as { cwd?: string; timeoutMs?: number }
          const result = await execSandbox(
            {
              command,
              cwd: execOptions.cwd ?? runner.state.cwd,
              ...(execOptions.timeoutMs === undefined ? {} : { timeout_ms: execOptions.timeoutMs }),
              permissions: {
                fs: { read: [runner.state.cwd], write: [runner.state.cwd] },
                net: false,
                env: { read: [] },
              },
            },
            signal,
          )
          return { stdout: result.stdout, stderr: result.stderr, code: result.exit_code }
        },
        fetch: async () => {
          throw new Error('plugin_http_not_connected')
        },
        ui: () => {
          throw new Error('plugin_ui_not_connected')
        },
        storage: async (plugin, operation, key, value) => {
          const isolated = `${plugin}:${key}`
          if (operation === 'set') pluginStorage.set(isolated, value)
          if (operation === 'delete') pluginStorage.delete(isolated)
          return pluginStorage.get(isolated)
        },
        config: () => undefined,
        log: (level, message) => {
          if (level === 'error') logger.error(message)
          else if (level === 'warn') logger.warn(message)
          else if (level === 'debug') logger.debug(message)
          else logger.info(message)
        },
      }),
      { dataRoot: join(home, 'plugin-data') },
    )
    for (const failure of await pluginRuntime.loadEnabled())
      logger.warn(`Plugin activation failed: ${failure.name}`)
    pluginRuntimes.add(pluginRuntime)
    return runner
  }
  dispatcher = new SubagentDispatcher({
    runnerFactory: createRunner,
    maxDepth: 3,
    maxConcurrency: 4,
    defaultBudget: {
      costUSDMax: 1,
      tokenMax: 200_000,
      timeMsMax: 10 * 60_000,
      toolCallMax: 100,
    },
  })
  const session = new RuntimeSessionPort(
    join(home, 'sessions'),
    createRunner,
    (input) => {
      permissionOptions.dangerouslySkip = input.skipPermissions
    },
    async () => {
      await Promise.all([...pluginRuntimes].map((runtime) => runtime.dispose()))
      pluginRuntimes.clear()
    },
    (input) => {
      streamToStdout = input.streamToStdout
    },
    (handler) => {
      interactivePermissionPrompt = handler
    },
  )
  return {
    version: options.version ?? '0.0.0',
    session,
    ui: {
      renderInteractiveApp: (input) => renderInteractiveApp({ history, ...input }),
    },
    restore: { restore: (sessionId, restoreOptions) => backups.restore(sessionId, restoreOptions) },
    evolution: {
      show: (showOptions) => evolution.audit(showOptions.namespace, showOptions.since),
      rollback: (rollbackOptions) =>
        evolution.rollback(rollbackOptions.namespace, rollbackOptions.to),
    },
    plugin: {
      async install(source) {
        await pluginsReady
        const manifest = await plugins.install(source)
        await Promise.all([...pluginRuntimes].map((runtime) => runtime.load(manifest.name)))
        return manifest
      },
      async uninstall(name) {
        await pluginsReady
        await Promise.all([...pluginRuntimes].map((runtime) => runtime.deactivate(name)))
        await plugins.uninstall(name)
      },
      async list() {
        await pluginsReady
        return plugins.list()
      },
      async setEnabled(name, enabled) {
        await pluginsReady
        await plugins.setEnabled(name, enabled)
        if (enabled) await Promise.all([...pluginRuntimes].map((runtime) => runtime.load(name)))
        else await Promise.all([...pluginRuntimes].map((runtime) => runtime.deactivate(name)))
      },
      async doctor(name) {
        await pluginsReady
        const state = plugins.list()[name]
        if (!state) throw new Error(`plugin_not_installed: ${name}`)
        const manifest = await plugins.inspect(join(pluginRoot, name))
        return {
          name: manifest.name,
          version: manifest.version,
          permissions: manifest.permissions.apollo,
        }
      },
    },
    telemetry: {
      securityEvent: (name, payload) => telemetry.emit(name, 'security', payload),
      summary: () => telemetryStore.summary(),
      export: (target) => telemetryStore.export(target),
      clear: () => telemetryStore.clear(),
      health: () => telemetryStore.health(),
    },
    confirmation: {
      confirmDangerousNoSandbox: async (sentence) =>
        (await promptLine(`Type "${sentence}" to continue: `)) === sentence,
    },
    auth: {
      async health() {
        const configured = Boolean(await auth.getCredential('anthropic'))
        return {
          configured,
          detail: configured
            ? 'anthropic credential available'
            : 'anthropic credential unavailable',
        }
      },
      async login(input) {
        const credential = input.credential ?? (await promptSecret('Anthropic API key: ')).trim()
        if (!credential) throw new Error('Credential input was cancelled')
        await auth.login(
          input.provider,
          credential,
          (value) => verifyAnthropicCredential(http, value),
          { flow: input.flow, dangerouslySkipVerify: input.dangerouslySkipVerify },
        )
        return { detail: `${input.provider} credential stored in encrypted credential store` }
      },
      async logout(provider) {
        await auth.logout(provider)
        return { detail: `${provider} credential removed` }
      },
    },
    config: {
      async health(cwd) {
        try {
          for (const path of [join(home, 'config.toml'), join(cwd, '.apollo', 'config.toml')]) {
            try {
              await access(path)
              await parseTomlFile(path)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
          }
          return { valid: true, detail: 'valid' }
        } catch (error) {
          return { valid: false, detail: error instanceof Error ? error.message : String(error) }
        }
      },
    },
    native: {
      async probe() {
        const info = await probeSandbox()
        const features = info.features as Record<string, unknown>
        const mechanism =
          typeof features.mechanism === 'string' ? features.mechanism : 'apollo-sandbox'
        const abi = typeof features.abi === 'string' ? features.abi : 'unknown'
        const disclosure = {
          tier: info.tier,
          mechanism,
          features: {
            filesystem: Boolean(features.filesystem ?? info.tier !== 'none'),
            network: Boolean(features.network),
          },
          degradationReasons: info.known_limitations,
        }
        await telemetry.emit('sandbox.probe', 'sandbox', {
          tier: disclosure.tier,
          mechanism: disclosure.mechanism,
          abi,
          version: options.version ?? '0.0.0',
          probedAt: new Date().toISOString(),
        })
        return disclosure
      },
      async health() {
        const [probe, search, fs] = await Promise.all([
          probeSandbox(),
          resolveBinary('search'),
          resolveBinary('fs'),
        ])
        return { sandbox: probe.tier !== 'none', search: search !== null, fs: fs !== null }
      },
    },
  }
}
