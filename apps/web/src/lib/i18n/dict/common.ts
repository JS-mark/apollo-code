/** web 字典公共命名空间（common.*）：i18n 骨架自用的跨切面文案。zh 为权威，en 同键。 */

export const commonZh = {
  'common.language': '界面语言',
  'common.languageHint': 'Web 控制台界面语言（浏览器本地保存）',
  'common.languageZh': '中文',
  'common.languageEn': 'English',
} as const

export type CommonKeys = keyof typeof commonZh

export const commonEn: Record<CommonKeys, string> = {
  'common.language': 'Language',
  'common.languageHint': 'Web console UI language (saved in this browser)',
  'common.languageZh': '中文',
  'common.languageEn': 'English',
}
