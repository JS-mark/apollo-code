import { InMemoryProviderRegistry, type ProviderCapabilities } from '@apollo-code/provider-kit'
import { describe, expect, it, vi } from 'vitest'

import {
  BufferedProviderStream,
  PluginError,
  registerProviderPlugin,
  renderAuthHeaders,
  validateManifest,
} from './index'

const manifest = {
  kind: 'provider' as const,
  name: 'apollo-plugin-provider-vllm' as const,
  version: '1.0.0',
  engines: { apollo: '^1.0.0' },
  main: 'index.js',
  type: 'module' as const,
  provider: {
    name: 'plugin-vllm',
    displayName: 'vLLM',
    auth: {
      mode: 'header-template' as const,
      credentialScope: 'vllm',
      headerTemplate: 'Authorization: Bearer {{key}}',
    },
  },
  permissions: {
    net: { allowlist: ['localhost:8000'] },
    apollo: ['provider.register', 'auth.getAuthHeaders'],
  },
}
const capabilities: ProviderCapabilities = {
  maxContextTokens: 8192,
  maxOutputTokens: 1024,
  toolUse: 'none',
  toolResultSchema: 'openai',
  vision: false,
  files: false,
  thinking: false,
  streaming: true,
  streamingReasoning: false,
  cache: 'none',
  jsonMode: true,
  structuredOutput: false,
  systemPromptLocation: 'system-field',
  toolChoiceRequired: false,
  interleavedThinking: false,
}

describe('provider plugin boundary', () => {
  it('requires provider permissions and a network allowlist', () => {
    expect(validateManifest(manifest, '1.2.0').kind).toBe('provider')
    expect(() =>
      validateManifest(
        { ...manifest, permissions: { ...manifest.permissions, net: false } },
        '1.2.0',
      ),
    ).toThrow('provider requires a net allowlist')
  })
  it('rejects header injection', () => {
    expect(renderAuthHeaders('Authorization: Bearer {{key}}', 'secret')).toEqual({
      Authorization: 'Bearer secret',
    })
    expect(() => renderAuthHeaders('Authorization: {{key}}', 'x\r\nX-Leak: yes')).toThrow(
      PluginError,
    )
  })
  it('injects only rendered headers into the child transport', async () => {
    const registry = new InMemoryProviderRegistry(),
      seen: unknown[] = []
    registerProviderPlugin({
      manifest,
      capabilities,
      registry,
      credentials: async () => 'raw-secret',
      transport: {
        async *stream(_name, request, signal) {
          seen.push(request, signal)
          yield { kind: 'text.delta', text: 'ok' }
        },
        dispose: vi.fn(async () => {}),
      },
    })
    const request = { model: 'llama', messages: [] }
    const chunks = []
    for await (const chunk of registry
      .get('plugin-vllm')!
      .stream(request, new AbortController().signal))
      chunks.push(chunk)
    expect(chunks).toEqual([{ kind: 'text.delta', text: 'ok' }])
    expect(seen[0]).toEqual({ ...request, authHeaders: { Authorization: 'Bearer raw-secret' } })
    expect(JSON.stringify(seen[0])).not.toContain('credentialScope')
  })
  it('fails explicitly instead of dropping chunks on overflow', () => {
    try {
      new BufferedProviderStream(10).accept({ kind: 'text.delta', text: 'too large' })
      throw new Error('expected overflow')
    } catch (error) {
      expect(error).toMatchObject({ code: 'stream_truncated' })
    }
  })
})
