import { access } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { AuthManager } from '@apollo-code/auth'
import { parseTomlFile } from '@apollo-code/config'
import {
  builtinPromptFragment,
  createSession,
  DefaultPromptComposer,
  EventBus,
  Runner,
  updateSession,
} from '@apollo-code/core'
import type { RunnerToolPort, SessionState } from '@apollo-code/core'
import { execSandbox, probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import { PermissionManager } from '@apollo-code/permission'
import type { PermissionDecision, PermissionRequest } from '@apollo-code/permission'
import { AnthropicClient } from '@apollo-code/provider-anthropic'
import type { HttpPort, HttpRequest, HttpResponse } from '@apollo-code/provider-anthropic'
import { SingleProviderRouter } from '@apollo-code/router'
import type { JsonValue } from '@apollo-code/shared'
import { SessionStore } from '@apollo-code/storage'
import { LocalTelemetrySink, Telemetry, TelemetryLogger } from '@apollo-code/telemetry'
import { ToolRegistry } from '@apollo-code/tool-kit'
import { builtinTools, ToolExecutor } from '@apollo-code/tools'
import { v7 as uuidv7 } from 'uuid'

import type { ApolloPorts, SessionPort } from './ports'

export type RunnerFactory = (state: SessionState, events: EventBus) => Runner
const terminalStatuses = new Set(['done', 'aborted', 'error'])
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class RuntimeSessionPort implements SessionPort {
  #runner: Runner | undefined
  #events: EventBus | undefined
  #store: SessionStore | undefined
  constructor(
    readonly sessionsDir: string,
    readonly createRunner: RunnerFactory,
    readonly onSecurity?: (input: { skipPermissions: boolean }) => void,
  ) {}
  configureSecurity(input: { skipPermissions: boolean }): void {
    this.onSecurity?.(input)
  }
  async start(input: { cwd: string; prompt?: string }): Promise<{ id: string }> {
    const id = uuidv7()
    await this.activate(
      createSession({ id, cwd: input.cwd, maxTokens: 200_000, toolRegistrySnapshot: 'builtin:l1' }),
      false,
    )
    const prompt = input.prompt ?? (await promptLine('> '))
    if (prompt) await this.#runner!.run(prompt)
    await this.snapshot()
    return { id }
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
    await this.#events.emit({
      type: 'session.ended',
      version: this.#runner.state.version,
      sessionId: this.#runner.state.id,
      payload: {},
    })
    await this.snapshot()
    this.#runner = undefined
    this.#events = undefined
    this.#store = undefined
  }
  private path(id: string): string {
    return join(this.sessionsDir, `${id}.jsonl`)
  }
  private async activate(state: SessionState, resumed: boolean): Promise<void> {
    const events = new EventBus()
    const store = new SessionStore(this.path(state.id))
    store.attach(events)
    this.#events = events
    this.#store = store
    this.#runner = this.createRunner(state, events)
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
      req.end(JSON.stringify(input.body))
    })
  }
}

async function promptLine(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return ''
  const io = createInterface({ input: stdin, output: stdout })
  try {
    return await io.question(question)
  } finally {
    io.close()
  }
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

export interface ProductionOptions {
  apolloHome?: string
  model?: string
  version?: string
}
export function createProductionPorts(options: ProductionOptions = {}): ApolloPorts {
  const home = options.apolloHome ?? join(homedir(), '.apollo')
  const telemetry = new Telemetry(new LocalTelemetrySink(join(home, 'telemetry', 'events.jsonl')))
  const logger = new TelemetryLogger(telemetry, 'cli')
  const auth = new AuthManager({ env: process.env, telemetry })
  const permissionOptions: { dangerouslySkip: boolean; logger: TelemetryLogger } = {
    dangerouslySkip: false,
    logger,
  }
  const permissions = new PermissionManager({}, permissionOptions)
  permissions.setPromptHandler(permissionPrompt)
  const anthropic = new AnthropicClient({
    credentials: {
      async getCredential() {
        const value = await auth.getCredential('anthropic')
        if (!value) throw new Error('Anthropic credential unavailable')
        return value
      },
    },
    http: new NodeHttpPort(),
  })
  const client = {
    ...anthropic,
    name: anthropic.name,
    capabilities: anthropic.capabilities,
    dispose: () => anthropic.dispose(),
    async *stream(request: Parameters<AnthropicClient['stream']>[0], signal: AbortSignal) {
      for await (const chunk of anthropic.stream(request, signal)) {
        if (chunk.kind === 'text.delta') stdout.write(chunk.text)
        yield chunk
      }
      stdout.write('\n')
    },
  }
  const createRunner: RunnerFactory = (state, events) => {
    const composer = new DefaultPromptComposer()
    composer.register(builtinPromptFragment)
    const registry = new ToolRegistry()
    for (const tool of builtinTools()) registry.register(tool)
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
    runner = new Runner(
      state,
      new SingleProviderRouter(client, options.model ?? 'claude-sonnet-4-20250514'),
      composer,
      tools,
      events,
    )
    return runner
  }
  const session = new RuntimeSessionPort(join(home, 'sessions'), createRunner, (input) => {
    permissionOptions.dangerouslySkip = input.skipPermissions
  })
  return {
    version: options.version ?? '0.0.0',
    session,
    telemetry: { securityEvent: (name, payload) => telemetry.emit(name, 'security', payload) },
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
        return {
          tier: info.tier,
          mechanism: String(features.mechanism ?? 'apollo-sandbox'),
          features: {
            filesystem: Boolean(features.filesystem ?? info.tier !== 'none'),
            network: Boolean(features.network),
          },
          degradationReasons: info.known_limitations,
        }
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
