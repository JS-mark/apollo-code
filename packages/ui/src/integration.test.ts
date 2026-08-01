import { describe, expect, it, vi } from 'vitest'

import {
  applyPickerSelection,
  createPickerCandidates,
  PermissionPromptQueue,
  resumeSessionView,
  createSessionView,
} from './index.ts'

describe('unified picker', () => {
  it('puts an alias before a same-named file and supports explicit file mode', () => {
    const aliases = [{ alias: 'sonnet', model: 'claude-sonnet-4' }]
    expect(
      createPickerCandidates('@son', aliases, ['sonnet', 'src/a.ts']).map((item) => item.kind),
    ).toEqual(['model', 'file'])
    expect(createPickerCandidates('@@son', aliases, ['sonnet']).map((item) => item.kind)).toEqual([
      'file',
    ])
    expect(
      applyPickerSelection(
        '@sonnet fix it',
        createPickerCandidates('@son', aliases, ['sonnet'])[0]!,
      ),
    ).toEqual({ hint: { explicitModel: 'claude-sonnet-4' }, text: 'fix it' })
  })
})

it('serializes permission prompts', async () => {
  let active = 0
  const show = vi.fn(async () => {
    active += 1
    expect(active).toBe(1)
    await Promise.resolve()
    active -= 1
    return 'allow-once' as const
  })
  const queue = new PermissionPromptQueue(show)
  await Promise.all([
    queue.request({ id: '1', description: 'write', risk: 'medium' }),
    queue.request({ id: '2', description: 'bash', risk: 'high' }),
  ])
  expect(show).toHaveBeenCalledTimes(2)
})

it('restores a transcript without reviving withdrawn output', () => {
  const view = createSessionView('s1')
  view.pendingText = 'partial'
  view.interruptedText = 'old'
  resumeSessionView(view, ['user: hello', 'assistant: hi'])
  expect(view).toMatchObject({
    status: 'active',
    pendingText: '',
    interruptedText: null,
    transcript: ['user: hello', 'assistant: hi'],
  })
})
