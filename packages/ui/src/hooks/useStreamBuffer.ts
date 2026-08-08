import { useCallback, useRef } from 'react'

export interface StreamBuffer {
  append(text: string): void
  flushNow(): string
  reset(): void
}

export function useStreamBuffer(onFlush: (text: string) => void, intervalMs = 33): StreamBuffer {
  const buffer = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flushNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    const text = buffer.current
    buffer.current = ''
    return text
  }, [])

  const append = useCallback(
    (text: string) => {
      if (!text) return
      buffer.current += text
      if (timer.current) return
      timer.current = setTimeout(() => {
        timer.current = undefined
        const flushed = flushNow()
        if (flushed) onFlush(flushed)
      }, intervalMs)
    },
    [flushNow, intervalMs, onFlush],
  )

  const reset = useCallback(() => {
    flushNow()
  }, [flushNow])

  return { append, flushNow, reset }
}
