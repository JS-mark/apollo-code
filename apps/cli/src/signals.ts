import type { SessionPort } from './ports.ts'
export function createSignalController(session: SessionPort): {
  handle(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM'): Promise<number>
} {
  return {
    async handle(signal) {
      if (signal === 'SIGINT') {
        await session.interrupt()
        return 130
      }
      await session.end()
      return 0
    },
  }
}
