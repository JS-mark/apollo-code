import { access } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
  EvolutionEngine,
  Runner,
  updateSession,
} from '@apollo-code/core'
import type { RunnerToolPort, SessionState } from '@apollo-code/core'
import { execSandbox, probeSandbox, resolveBinary } from '@apollo-code/native-bridge'
import { PermissionManager } from '@apollo-code/permission'
import type { PermissionDecision, PermissionRequest } from '@apollo-code/permission'
import { PluginManager } from '@apollo-code/plugin-runtime'
import { AnthropicClient, verifyAnthropicCredential } from '@apollo-code/provider-anthropic'
import type { HttpPort, HttpRequest, HttpResponse } from '@apollo-code/provider-anthropic'
import { SingleProviderRouter } from '@apollo-code/router'
import type { JsonValue } from '@apollo-code/shared'
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
import { v7 as uuidv7 } from 'uuid'

import type { ApolloPorts, SessionPort } from './ports'

export type RunnerFactory = (state: SessionState, events: EventBus) => Runner | Promise<Runner>
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
  if (!stdin.isTTY || !stdout.isTTY) return ''
  const io = createInterface({ input: stdin, output: stdout })
  try {
    return await io.question(question)
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

export interface ProductionOptions {
  apolloHome?: string
  model?: string
  version?: string
}
export function createProductionPorts(options: ProductionOptions = {}): ApolloPorts {
  const home = options.apolloHome ?? process.env.APOLLO_HOME ?? join(homedir(), '.apollo')
  const backups = new BackupStore(join(home, 'backups'))
  const evolution = new EvolutionStore(join(home, 'tuning'))
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
  let dispatcher: SubagentDispatcher
  const createRunner: RunnerFactory = async (state, events) => {
    // A manager per Runner is intentional: child sessions cannot inherit parent permission cache.
    const permissions = new PermissionManager({}, permissionOptions)
    permissions.setPromptHandler(async (request) => {
      const decision = await permissionPrompt(request)
      if (state.lineage.depth === 0) return decision
      return ['allow-once', 'allow-session', 'deny'].includes(decision.kind)
        ? decision
        : { kind: 'deny' }
    })
    let evolutionEnabled = true
    try {
      const config = await parseTomlFile(join(home, 'config.toml'))
      const section = config.evolution
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
          if (chunk.kind === 'text.delta') stdout.write(chunk.text)
          yield chunk
        }
        stdout.write('\n')
      },
    }
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
    runner = new Runner(
      state,
      new SingleProviderRouter(client, options.model ?? 'claude-sonnet-4-20250514'),
      composer,
      tools,
      events,
      {},
      contextPolicy,
    )
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
  const session = new RuntimeSessionPort(join(home, 'sessions'), createRunner, (input) => {
    permissionOptions.dangerouslySkip = input.skipPermissions
  })
  return {
    version: options.version ?? '0.0.0',
    session,
    restore: { restore: (sessionId, restoreOptions) => backups.restore(sessionId, restoreOptions) },
    evolution: {
      show: (showOptions) => evolution.audit(showOptions.namespace, showOptions.since),
      rollback: (rollbackOptions) =>
        evolution.rollback(rollbackOptions.namespace, rollbackOptions.to),
    },
    plugin: {
      async install(source) {
        await pluginsReady
        return plugins.install(source)
      },
      async uninstall(name) {
        await pluginsReady
        await plugins.uninstall(name)
      },
      async list() {
        await pluginsReady
        return plugins.list()
      },
      async setEnabled(name, enabled) {
        await pluginsReady
        await plugins.setEnabled(name, enabled)
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
