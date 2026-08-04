const SECRET_KEY = /(authorization|api[_-]?key|token|secret|passphrase|password|oauth[_-]?code)/i

export function sanitize<T>(value: T): T {
  const seen = new WeakSet<object>()
  const visit = (input: unknown, key = ''): unknown => {
    if (SECRET_KEY.test(key)) return '[REDACTED]'
    if (typeof input === 'string')
      return input
        .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
        .replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, '$1[REDACTED]')
        .replace(
          /\b((?:api[_-]?key|token|secret|password|oauth[_-]?code)\s*[=:]\s*)[^\s&,;]+/gi,
          '$1[REDACTED]',
        )
        .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    if (!input || typeof input !== 'object') return input
    if (seen.has(input)) return '[Circular]'
    seen.add(input)
    if (Array.isArray(input)) return input.map((item) => visit(item))
    return Object.fromEntries(Object.entries(input).map(([k, item]) => [k, visit(item, k)]))
  }
  return visit(value) as T
}
