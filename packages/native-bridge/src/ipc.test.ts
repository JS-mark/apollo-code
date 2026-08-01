import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { RpcPeer } from './ipc.js'

describe('RpcPeer', () => {
  it('rejects malformed protocol frames without losing later frames', async () => {
    const input = new PassThrough(); const output = new PassThrough()
    const peer = new RpcPeer(input, output)
    const response = peer.requestWithId(1, 'fs.diff', {})
    input.write('not-json\n{"jsonrpc":"2.0","id":1,"result":"ok"}\n')
    await expect(response).resolves.toBe('ok')
  })
})
