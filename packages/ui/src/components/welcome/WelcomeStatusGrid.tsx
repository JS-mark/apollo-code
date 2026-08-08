import { Box, Text } from 'ink'

import type { StatusTone, WelcomeLayoutMode, WelcomeScreenState } from './types'
import { colorForTone } from './welcomeTheme'

export function WelcomeStatusGrid({
  layout,
  state,
}: {
  layout: WelcomeLayoutMode
  state: WelcomeScreenState
}) {
  const rows: Array<[string, string, StatusTone, string, string, StatusTone]> = [
    [
      'Workspace',
      state.workspace.displayCwd,
      'default',
      'Trust',
      state.workspace.trustLabel,
      state.workspace.trustTone,
    ],
    [
      'Model',
      state.provider.label,
      'default',
      'Auth',
      state.provider.authLabel,
      state.provider.authTone,
    ],
    [
      'Sandbox',
      state.sandbox.label,
      state.sandbox.tone,
      'Permission',
      state.permission.label,
      state.permission.tone,
    ],
    ['Session', state.session.label, 'default', 'Context', state.session.contextLabel, 'info'],
  ]
  const visible = layout === 'minimal' ? rows.slice(0, 3) : rows
  return (
    <Box flexDirection="column" flexGrow={1}>
      {visible.map(([a, av, at, b, bv, bt]) =>
        layout === 'full' ? (
          <Box key={a}>
            <Cell label={a} value={av} tone={at} />
            <Cell label={b} value={bv} tone={bt} />
          </Box>
        ) : (
          <Box flexDirection="column" key={a}>
            <Cell label={a} value={av} tone={at} />
            <Cell label={b} value={bv} tone={bt} />
          </Box>
        ),
      )}
    </Box>
  )
}

function Cell({ label, tone, value }: { label: string; tone: StatusTone; value: string }) {
  return (
    <Box width={42}>
      <Box width={12}>
        <Text color="gray">{label}</Text>
      </Box>
      <Text color={colorForTone(tone)} wrap="truncate-end">
        {value}
      </Text>
    </Box>
  )
}
