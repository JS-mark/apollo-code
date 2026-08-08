import { Text } from 'ink'

import type { ModelPickerOption } from '../model-picker'
import { PanelFrame } from './PanelFrame'
import { SelectList } from './SelectList'

export interface ModelPickerProps {
  activeId: string
  currentModelId: string
  models: readonly ModelPickerOption[]
  onActiveChange?: (id: string) => void
  onCancel?: () => void
  onSubmit?: (id: string) => void
}

export function ModelPicker({
  activeId,
  currentModelId,
  models,
  onActiveChange,
  onCancel,
  onSubmit,
}: ModelPickerProps) {
  return (
    <PanelFrame footer="Enter select | Esc cancel" title="Select model">
      <SelectList
        activeId={activeId}
        disabledBehavior="focusable"
        items={models.map((model) => ({
          id: model.id,
          label: model.label,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.disabled === undefined ? {} : { disabled: model.disabled }),
          selected: model.id === currentModelId,
        }))}
        {...(onActiveChange === undefined ? {} : { onActiveChange })}
        {...(onCancel === undefined ? {} : { onCancel })}
        {...(onSubmit === undefined ? {} : { onSubmit })}
      />
      <Text color="gray">Unavailable models are muted and skipped by keyboard selection.</Text>
    </PanelFrame>
  )
}
