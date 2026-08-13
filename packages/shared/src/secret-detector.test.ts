import { describe, expect, it } from 'vitest'

import { detectSecret, type SecretKind } from './secret-detector'

describe('detectSecret', () => {
  it.each<[SecretKind, string]>([
    ['openai_api_key', `sk-proj-${'FAKE'.repeat(6)}`],
    ['provider_token', `sk-ant-api03-${'FAKE'.repeat(6)}`],
    ['github_token', `ghp_${'FAKE'.repeat(8)}`],
    ['github_token', `github_pat_${'FAKE_'.repeat(5)}`],
    ['aws_access_key', `AKIA${'FAKE'.repeat(4)}`],
    ['google_api_key', `AIza${'FAKE'.repeat(7)}`],
    ['npm_token', `npm_${'FAKE'.repeat(7)}`],
    ['provider_token', `hf_${'FAKE'.repeat(7)}`],
    ['provider_token', `xoxb-${'FAKE'.repeat(5)}`],
    ['provider_token', `sk_test_${'FAKE'.repeat(5)}`],
    ['provider_token', `SG.${'FAKE'.repeat(4)}.${'FAKE'.repeat(4)}`],
    ['jwt', `eyJ${'F'.repeat(8)}.${'A'.repeat(12)}.${'K'.repeat(12)}`],
    ['authorization_header', `Authorization: Bearer ${'FAKE'.repeat(4)}`],
    ['authorization_header', `Proxy-Authorization = Basic ${'RkFLRQ=='.repeat(2)}`],
    ['credential_uri', `postgresql://apollo:${'FAKE'.repeat(3)}@db.example.test/main`],
    ['credential_uri', 'redis://apollo:p@cache.example.test/0'],
    ['credential_assignment', `client_secret => ${'FAKE'.repeat(3)}`],
    ['private_key', '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----'],
  ])('classifies %s without retaining the matching value', (kind, value) => {
    expect(detectSecret(value)).toEqual({ kind })
    expect(JSON.stringify(detectSecret(value))).not.toContain('FAKE')
  })

  it.each([
    `ｓｋ－ｐｒｏｊ－${'FAKE'.repeat(6)}`,
    `ghp_\u200B${'FAKE'.repeat(8)}`,
    `ＡＫＩＡ${'FAKE'.repeat(4)}`,
    `api．key ： ${'FAKE'.repeat(3)}`,
    `Authorization：Bearer\u2060${'FAKE'.repeat(4)}`,
  ])('normalizes Unicode and invisible separator variants', (value) => {
    expect(detectSecret(value)).toBeDefined()
  })

  it.each([
    'Use the GitHub provider for pull requests.',
    'The token budget is 8k.',
    'Rotate credentials every 90 days.',
    'api_key: [REDACTED]',
    'token = ${ACCESS_TOKEN}',
    'password: example',
    'https://user:example@example.test/docs',
    'The prefix sk-proj- is documented here.',
    'AWS access key IDs begin with AKIA.',
    'eyJ is a common base64 prefix, not a complete JWT.',
  ])('does not flag ordinary prose or explicit placeholders: %s', (value) => {
    expect(detectSecret(value)).toBeUndefined()
  })

  it('continues scanning after harmless placeholders', () => {
    expect(detectSecret(`api_key: [REDACTED]\npassword: ${'FAKE'.repeat(3)}`)).toEqual({
      kind: 'credential_assignment',
    })
    expect(
      detectSecret(
        `https://user:example@example.test/docs\nredis://user:${'FAKE'.repeat(3)}@cache.example.test`,
      ),
    ).toEqual({ kind: 'credential_uri' })
  })
})
