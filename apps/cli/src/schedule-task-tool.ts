/**
 * schedule_task 会话工具（W-17）：模型经它创建/管理持久任务定义，写的是
 * `volund tasks` 命令族同一个 TaskStore（同锁同校验）——触发权仍归 daemon
 * （F1-01 不变，工具只写定义表）。变更动作（create/enable/disable/remove）
 * 带 custom 权限 spec 进统一决策链：交互模式弹卡确认，无人值守（none 模式）
 * 默认 deny——与 F1-03 同门。list/runs 只读放行。
 *
 * 创建返回里附触发就绪检查（[tasks].enabled / daemon 在场），模型据此提醒
 * 用户补齐触发条件，避免「创建成功但永不执行」的静默失败。
 */
import type { TaskDefinition, TaskSchedule } from '@volund/shared'
import { validateTaskDefinition } from '@volund/shared'
import { TaskStore } from '@volund/storage'
import type { Tool, ToolResult } from '@volund/tool-kit'

import { slugifyTaskId } from './commands/tasks'
import { computeConfigHash, taskStorePath } from './daemon'

export const SCHEDULE_TASK_TOOL_NAME = 'schedule_task'

export interface TaskSchedulerReadiness {
  enabled: boolean
  daemonRunning: boolean
  pid?: number
}

function text(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    meta: { durationMs: 0, costImpact: 'safe' },
  }
}

export function createScheduleTaskTool(options: {
  /** VOLUND_HOME 解析（configHash 冻结 + TaskStore 路径）。 */
  home: string
  /** 新任务的缺省 cwd（当前会话工作区）。 */
  sessionCwd: string
  /** 调度器就绪状态（[tasks].enabled 现读 + daemon.lock 探测）。 */
  status: () => Promise<TaskSchedulerReadiness>
}): Tool {
  const store = new TaskStore(taskStorePath(options.home))

  const readiness = async (): Promise<string[]> => {
    const status = await options.status()
    const notes: string[] = []
    if (!status.enabled)
      notes.push(
        'scheduler is disabled: set enabled = true in the [tasks] section of your user-level config.toml',
      )
    if (!status.daemonRunning)
      notes.push(
        'no daemon is running: start `volund daemon` (keep it alive with launchd/systemd for 7x24)',
      )
    return notes
  }

  return {
    name: SCHEDULE_TASK_TOOL_NAME,
    description:
      'Create and manage persistent scheduled tasks (cron-like automation). ' +
      'Tasks run the given prompt as an unattended headless session (default-deny permissions) ' +
      'when the volund daemon fires them. Actions: list, create, enable, disable, remove, runs. ' +
      'A task only fires when [tasks].enabled=true in user config AND `volund daemon` is running.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'enable', 'disable', 'remove', 'runs'] },
        id: {
          type: 'string',
          description: 'task id (enable/disable/remove/runs; optional for create)',
        },
        name: { type: 'string', description: 'create: human-readable name' },
        prompt: { type: 'string', description: 'create: prompt executed unattended on every fire' },
        schedule: {
          type: 'object',
          description: 'create: when to fire',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['interval', 'daily', 'weekly'] },
            everyMs: {
              type: 'integer',
              minimum: 60_000,
              description: 'interval: milliseconds (>= 60000)',
            },
            at: { type: 'string', description: 'daily/weekly: HH:MM (24h)' },
            weekdays: {
              type: 'array',
              items: { type: 'integer', minimum: 0, maximum: 6 },
              description: 'weekly: 0=Sunday',
            },
          },
        },
        cwd: {
          type: 'string',
          description: 'create: working directory (default: current workspace)',
        },
        timezone: { type: 'string', description: 'create: IANA time zone (default: host local)' },
        missedRun: {
          type: 'string',
          enum: ['skip', 'run_latest'],
          description: 'create: missed-window policy while the daemon is down',
        },
        overlap: {
          type: 'string',
          enum: ['skip', 'queue'],
          description: 'create: in-flight overlap policy',
        },
        model: { type: 'string', description: 'create: pin a provider/model for runs' },
        timeoutMs: { type: 'integer', description: 'create: per-run wall-clock limit' },
        maxRetries: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          description: 'create: retry budget',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'runs: journal size (default 10)',
        },
      },
    },
    permissionSpec: (input: unknown) => {
      const action = (input as { action?: unknown }).action
      const mutating =
        action === 'create' || action === 'enable' || action === 'disable' || action === 'remove'
      if (!mutating) return {}
      const id = (input as { id?: unknown }).id
      return {
        custom: {
          scheduleTask: {
            action,
            ...(typeof id === 'string' ? { id } : {}),
          },
        },
      }
    },
    readonly: false,
    async invoke(value: unknown) {
      const input = value as {
        action: 'list' | 'create' | 'enable' | 'disable' | 'remove' | 'runs'
        id?: string
        name?: string
        prompt?: string
        schedule?: TaskSchedule
        cwd?: string
        timezone?: string
        missedRun?: 'skip' | 'run_latest'
        overlap?: 'skip' | 'queue'
        model?: string
        timeoutMs?: number
        maxRetries?: number
        limit?: number
      }
      switch (input.action) {
        case 'list':
          return text(await store.listTasks())
        case 'runs':
          if (!input.id) return text({ error: 'id is required for the runs action' })
          return text(await store.recentRuns({ taskId: input.id, limit: input.limit ?? 10 }))
        case 'enable':
        case 'disable': {
          if (!input.id) return text({ error: 'id is required' })
          const existing = await store.getTask(input.id)
          if (!existing) return text({ error: `no such task: ${input.id}` })
          const updated = await store.upsertTask({
            ...existing,
            enabled: input.action === 'enable',
          })
          return text({ updated: { id: updated.id, enabled: updated.enabled } })
        }
        case 'remove': {
          if (!input.id) return text({ error: 'id is required' })
          const removed = await store.removeTask(input.id)
          return removed
            ? text({ removed: input.id })
            : text({ error: `no such task: ${input.id}` })
        }
        case 'create': {
          if (!input.name || !input.prompt || !input.schedule) {
            return text({ error: 'name, prompt and schedule are required for the create action' })
          }
          // F1-02：与 CLI 同源冻结 configHash；运行前 daemon 重验（F1-03）。
          const definition: TaskDefinition = {
            id: input.id ?? slugifyTaskId(input.name),
            name: input.name,
            enabled: true,
            prompt: input.prompt,
            cwd: input.cwd ?? options.sessionCwd,
            schedule: input.schedule,
            missedRun: input.missedRun ?? 'skip',
            overlap: input.overlap ?? 'skip',
            configHash: await computeConfigHash(options.home),
            createdAt: Date.now(),
            ...(input.timezone ? { timezone: input.timezone } : {}),
            ...(input.model || input.timeoutMs !== undefined || input.maxRetries !== undefined
              ? {
                  constraints: {
                    ...(input.model ? { model: input.model } : {}),
                    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
                    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
                  },
                }
              : {}),
          }
          const validated = validateTaskDefinition(definition)
          if (!validated.ok) return text({ error: 'validation failed', issues: validated.issues })
          const saved = await store.upsertTask(validated.value)
          const notes = await readiness()
          return text({
            created: {
              id: saved.id,
              schedule: saved.schedule,
              cwd: saved.cwd,
              enabled: saved.enabled,
            },
            ...(notes.length > 0 ? { warnings: notes } : {}),
          })
        }
      }
    },
  }
}
