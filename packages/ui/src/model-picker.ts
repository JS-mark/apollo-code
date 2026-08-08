export interface ModelPickerOption {
  description?: string
  disabled?: boolean
  id: string
  label: string
  model: string
  provider: string
}

export interface ModelPickerState {
  currentModelId: string
  models: readonly ModelPickerOption[]
}

export interface SubmitOptions {
  model?: string
}
