import { describe, expect, it, vi } from 'vitest'

import { unavailablePorts } from '../ports'
import { CommandRegistry } from './command-registry'

const context = {
  args: { _: ['probe'] },
  cwd: '/workspace',
  ports: unavailablePorts(),
}

describe('CommandRegistry', () => {
  it('dispatches a registered command with its typed context', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' }))
    const registry = new CommandRegistry([{ name: 'probe', run }])

    await expect(registry.dispatch('probe', context)).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    })
    expect(run).toHaveBeenCalledWith(context)
  })

  it('rejects duplicate names at composition time', () => {
    const command = { name: 'probe', run: vi.fn() }
    expect(() => new CommandRegistry([command, command])).toThrow('Duplicate command: probe')
  })
})
