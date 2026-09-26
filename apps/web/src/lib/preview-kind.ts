/**
 * 产物预览路由（工作台文件查看器的渲染器选择）：按扩展名把文件分派到
 * 图片 / 网页沙箱 / PDF / Markdown / 文本五类渲染面。纯函数无 IO。
 * 未命中扩展名一律回落 text（既有文本查看器对二进制有自己的兜底）。
 */
export type PreviewKind = 'image' | 'html' | 'pdf' | 'markdown' | 'text'

const EXT_KINDS: Record<string, PreviewKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
}

export function previewKindOf(path: string): PreviewKind {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'text'
  return EXT_KINDS[name.slice(dot + 1).toLowerCase()] ?? 'text'
}
