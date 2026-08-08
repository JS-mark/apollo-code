import { Box, Text, useInput } from 'ink'

import type {
  InteractivePermissionDecisionKind,
  InteractivePermissionRequest,
  PermissionPromptController,
} from '../permission'

export interface PermissionPromptStackProps {
  controller: PermissionPromptController
  requests: readonly InteractivePermissionRequest[]
}

export function PermissionPromptStack({ controller, requests }: PermissionPromptStackProps) {
  const request = requests[0]
  useInput(
    (input) => {
      if (!request) return
      const decision = decisionForInput(input)
      if (!decision) return
      controller.decide(request.id, { kind: decision })
    },
    { isActive: Boolean(request) },
  )

  if (!request) return null

  return (
    <Box borderColor="yellow" borderStyle="round" flexDirection="column" paddingX={1}>
      <Text color="yellow">Permission required: {request.toolName}</Text>
      <Text color="gray">{JSON.stringify(request.spec)}</Text>
      <Text>
        <Text color="green">a</Text> allow once <Text color="cyan">s</Text> allow session{' '}
        <Text color="red">d</Text> deny
      </Text>
      {requests.length > 1 ? <Text color="gray">{requests.length - 1} queued</Text> : null}
    </Box>
  )
}

function decisionForInput(input: string): InteractivePermissionDecisionKind | undefined {
  if (input === 'a') return 'allow-once'
  if (input === 's') return 'allow-session'
  if (input === 'd') return 'deny'
}
