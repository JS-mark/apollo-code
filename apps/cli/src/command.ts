import { defineCommand } from 'citty'

import type { AppIdentity } from './shared/app-identity'

const leaf = (name: string, description: string) => defineCommand({ meta: { name, description } })
export const createCommand = (identity: AppIdentity) =>
  defineCommand({
    meta: {
      name: 'apollo',
      version: identity.version,
      description: 'Open, model-agnostic AI coding CLI',
    },
    subCommands: {
      chat: leaf('chat', 'Start an interactive chat'),
      resume: leaf('resume', 'Resume a saved session'),
      restore: leaf('restore', 'Restore files changed by a saved session'),
      login: leaf('login', 'Configure provider credentials'),
      logout: leaf('logout', 'Remove provider credentials'),
      config: leaf('config', 'Inspect configuration'),
      status: leaf('status', 'Show redacted runtime and configuration status'),
      history: leaf('history', 'List or show sessions'),
      context: leaf('context', 'Inspect and control context compaction'),
      evolution: leaf('evolution', 'Inspect and rollback local tuning'),
      plugin: leaf('plugin', 'Install and manage sandboxed plugins'),
      telemetry: leaf('telemetry', 'Inspect, export, or clear local telemetry'),
      trust: leaf('trust', 'List or revoke trusted directories'),
      doctor: leaf('doctor', 'Diagnose L1 dependencies'),
      memory: leaf('memory', 'Search and maintain local memory'),
      hook: leaf('hook', 'List builtin hooks'),
      mcp: leaf('mcp', 'List, test, and inspect MCP servers'),
      version: leaf('version', 'Print version'),
      help: leaf('help', 'Show command help'),
    },
  })

/** Stable test fixture; production uses createCommand(appIdentity). */
export const command = createCommand({ version: '0.0.0-test' })
