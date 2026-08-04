import { defineCommand } from 'citty'
const leaf = (name: string, description: string) => defineCommand({ meta: { name, description } })
export const command = defineCommand({
  meta: { name: 'apollo', version: '0.0.0', description: 'Open, model-agnostic AI coding CLI' },
  subCommands: {
    chat: leaf('chat', 'Start a one-shot chat'),
    resume: leaf('resume', 'Resume a saved session'),
    restore: leaf('restore', 'Restore files changed by a saved session'),
    login: leaf('login', 'Configure provider credentials'),
    logout: leaf('logout', 'Remove provider credentials'),
    config: leaf('config', 'Inspect configuration'),
    history: leaf('history', 'List or show sessions'),
    context: leaf('context', 'Inspect and control context compaction'),
    evolution: leaf('evolution', 'Inspect and rollback local tuning'),
    telemetry: leaf('telemetry', 'Inspect, export, or clear local telemetry'),
    doctor: leaf('doctor', 'Diagnose L1 dependencies'),
    hook: leaf('hook', 'List builtin hooks'),
    mcp: leaf('mcp', 'List, test, and inspect MCP servers'),
    version: leaf('version', 'Print version'),
    help: leaf('help', 'Show command help'),
  },
})
