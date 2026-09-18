// Plain helpers (no components) for authoring a set of form-field
// definitions -- split out from components/FormFieldsEditor.jsx so that
// file exports only components (react-refresh/only-export-components).

export const FIELD_TYPE_OPTIONS = [
  { value: 'TEXT', label: 'Text' },
  { value: 'TEXTAREA', label: 'Textarea' },
  { value: 'NUMBER', label: 'Number' },
  { value: 'CURRENCY', label: 'Currency' },
  { value: 'DATE', label: 'Date' },
  { value: 'SELECT', label: 'Select' },
  { value: 'CHECKBOX', label: 'Checkbox' },
]

let nextFieldKey = 0

// A brand-new field has no server id yet, so it needs some other stable
// identity for React's key prop -- an existing field just uses its real id.
function draftFieldKey() {
  nextFieldKey += 1
  return `new-${nextFieldKey}`
}

export function emptyFormField(order) {
  return {
    key: draftFieldKey(),
    id: undefined,
    label: '',
    field_type: 'TEXT',
    options: [],
    required: false,
    order,
    help_text: '',
  }
}

// Strips the client-only `key`, keeping `id` only where a real one exists
// (JSON.stringify drops an undefined value entirely) -- matches what both
// RequirementTemplateSerializer.form_fields (add/edit/reorder/delete by
// resending the whole list) and PhaseRequirementSerializer.custom_fields
// (write-only, create-time-only) expect.
export function formFieldsPayload(fields) {
  return fields.map((field) => {
    const payload = { ...field }
    delete payload.key
    return payload
  })
}
