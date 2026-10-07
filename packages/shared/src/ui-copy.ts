/**
 * 跨端 UI 文案表（web / mobile / TUI 三端共用的「同文案、多份实现」收编面）。
 * 此前工具名映射（web session-stream / mobile chat.ts）、审批决策档位
 * （TUI PermissionPromptStack / mobile PermissionStack）、能力行标签
 * （TUI 卡面 / mobile permission-spec）各自手抄、注释互指；i18n-r1 起以本表
 * 为唯一权威：zh 中文、en 英文，TUI 英文单语恒取 en，web/mobile 按 locale 取。
 */

import type { Bilingual, Locale } from './i18n'

/** 双语条目取值（i18n.pick 的表级便捷形式）。 */
export function pickCopy(copy: Bilingual, locale: Locale): string {
  return copy[locale]
}

/**
 * 工具展示名（卡片标题/状态行的名词）。未知工具回退原名；
 * MCP 工具不走本表（`mcp__server__tool` 由各端拆成 `server/name` 展示）。
 */
export const TOOL_LABELS: Record<string, Bilingual> = {
  Bash: { en: 'Terminal', zh: '终端' },
  ShellOutput: { en: 'Terminal output', zh: '终端输出' },
  KillShell: { en: 'Stop terminal', zh: '结束终端' },
  Read: { en: 'Read', zh: '读取' },
  Write: { en: 'Write', zh: '写入' },
  Edit: { en: 'Edit', zh: '编辑' },
  MultiEdit: { en: 'Multi-edit', zh: '编辑' },
  Glob: { en: 'Find files', zh: '找文件' },
  Grep: { en: 'Search content', zh: '搜内容' },
  WebFetch: { en: 'Fetch page', zh: '抓网页' },
  WebSearch: { en: 'Web search', zh: '搜网页' },
  Skill: { en: 'Skill', zh: '技能' },
  Task: { en: 'Subagent', zh: '子代理' },
}

/** 审批决策档位（三端共用 id 词汇表，数字/快捷键编排在各端）。 */
export type PermissionDecisionKind =
  | 'allow-once'
  | 'allow-session'
  | 'allow-project'
  | 'allow-forever'
  | 'allow-all-session'
  | 'deny'
  | 'deny-forever'

/**
 * 决策档位标签。full 为卡面全称（TUI 权限卡 / web）；short 为紧凑变体
 * （mobile 底部 pill），无紧凑变体需求时两端各取所需即可。
 */
export const PERMISSION_DECISION_LABELS: Record<
  PermissionDecisionKind,
  { full: Bilingual; short: Bilingual }
> = {
  'allow-once': {
    full: { en: 'Allow once', zh: '允许一次' },
    short: { en: 'Allow', zh: '允许本次' },
  },
  'allow-session': {
    full: { en: 'Allow for this session', zh: '本会话内允许' },
    short: { en: 'This session', zh: '本会话' },
  },
  'allow-project': {
    full: { en: 'Remember for this project', zh: '项目内记住' },
    short: { en: 'Project', zh: '项目' },
  },
  'allow-forever': {
    full: { en: 'Always allow', zh: '始终允许' },
    short: { en: 'Always', zh: '永久' },
  },
  'allow-all-session': {
    full: { en: 'Allow all (this session)', zh: '全部放行（本会话）' },
    short: { en: 'Allow all', zh: '全放行' },
  },
  deny: { full: { en: 'Deny', zh: '拒绝' }, short: { en: 'Deny', zh: '拒绝' } },
  'deny-forever': { full: { en: 'Never ask', zh: '永不询问' }, short: { en: 'Never', zh: '永不' } },
}

/** 审批卡能力行的 gutter 标签（display.spec 的 fs/bash/net/env/custom 维度）。 */
export const SPEC_KIND_LABELS: Record<
  'read' | 'write' | 'run' | 'net' | 'env' | 'custom',
  Bilingual
> = {
  read: { en: 'Read', zh: '读取' },
  write: { en: 'Write', zh: '写入' },
  run: { en: 'Run', zh: '运行' },
  net: { en: 'Network', zh: '网络' },
  env: { en: 'Env', zh: '环境' },
  custom: { en: 'Custom', zh: '自定义' },
}

/** 编辑类正文的新旧对照段标记（web/mobile diffPair 共用）。 */
export const DIFF_PAIR_MARKERS: { new: Bilingual; old: Bilingual } = {
  old: { en: '[old]', zh: '【旧】' },
  new: { en: '[new]', zh: '【新】' },
}
