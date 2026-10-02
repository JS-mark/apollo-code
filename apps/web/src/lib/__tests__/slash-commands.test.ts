import { describe, expect, it } from 'vitest'

import { WEB_SLASH_COMMANDS, slashCandidates, slashQueryAt } from '../slash-commands'

describe('web slash commands (W-05)', () => {
  it('slashQueryAt：/ 开头且无空白才触发', () => {
    expect(slashQueryAt('/int')).toBe('int')
    expect(slashQueryAt('/')).toBe('')
    expect(slashQueryAt('/in text')).toBeUndefined()
    expect(slashQueryAt('say /int')).toBeUndefined()
    expect(slashQueryAt('/multi\nline')).toBeUndefined()
  })

  it('slashCandidates：name + alias 前缀、按名称排序', () => {
    const names = slashCandidates('').map((command) => command.name)
    expect(names).toEqual([...names].sort())
    expect(slashCandidates('int').map((command) => command.name)).toEqual(['interrupt'])
    expect(slashCandidates('exit').map((command) => command.name)).toEqual(['end'])
    expect(slashCandidates('zzz')).toEqual([])
    expect(WEB_SLASH_COMMANDS.length).toBeGreaterThanOrEqual(3)
  })
})
