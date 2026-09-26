import { describe, expect, it } from 'vitest'

import { previewKindOf } from './preview-kind'

describe('previewKindOf', () => {
  it('routes image extensions', () => {
    expect(previewKindOf('dist/logo.png')).toBe('image')
    expect(previewKindOf('a/b/plot.SVG')).toBe('image')
    expect(previewKindOf('favicon.ico')).toBe('image')
    expect(previewKindOf('shot.jpeg')).toBe('image')
  })

  it('routes html and pdf artifacts', () => {
    expect(previewKindOf('dist/index.html')).toBe('html')
    expect(previewKindOf('report.htm')).toBe('html')
    expect(previewKindOf('docs/spec.pdf')).toBe('pdf')
  })

  it('routes markdown files', () => {
    expect(previewKindOf('README.md')).toBe('markdown')
    expect(previewKindOf('notes.markdown')).toBe('markdown')
  })

  it('falls back to text for code and dotfiles', () => {
    expect(previewKindOf('src/index.ts')).toBe('text')
    expect(previewKindOf('package.json')).toBe('text')
    expect(previewKindOf('.gitignore')).toBe('text')
    expect(previewKindOf('Makefile')).toBe('text')
  })
})
