import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Col from 'react-bootstrap/Col'
import Form from 'react-bootstrap/Form'
import Row from 'react-bootstrap/Row'
import { emptyFormField, FIELD_TYPE_OPTIONS } from '../formFields.js'

export function UpDownIcon({ direction, ...props }) {
  const d = direction === 'up' ? 'M8 4 3.5 10.5h9z' : 'M8 12 3.5 5.5h9z'
  return (
    <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <path d={d} />
    </svg>
  )
}

// Add/edit/reorder/delete a set of form-field definitions -- shared by
// RequirementTemplates.jsx (a template's fields, starting from its existing
// ones) and LeadDetail.jsx's AddTaskForm (a custom task's fields, starting
// from none). Purely local state; the parent form's own Save/Create submits
// the whole edited list in one request via formFieldsPayload above.
export default function FormFieldsEditor({ fields, setFields }) {
  const sorted = [...fields].sort((a, b) => a.order - b.order)

  function updateField(key, patch) {
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  }

  function addField() {
    const nextOrder = fields.length > 0 ? Math.max(...fields.map((f) => f.order)) + 1 : 1
    setFields((prev) => [...prev, emptyFormField(nextOrder)])
  }

  function removeField(key) {
    setFields((prev) => prev.filter((f) => f.key !== key))
  }

  function moveField(key, direction) {
    const index = sorted.findIndex((f) => f.key === key)
    const swapWith = direction === 'up' ? sorted[index - 1] : sorted[index + 1]
    if (!swapWith) return
    const target = sorted[index]
    setFields((prev) =>
      prev.map((f) => {
        if (f.key === target.key) return { ...f, order: swapWith.order }
        if (f.key === swapWith.key) return { ...f, order: target.order }
        return f
      }),
    )
  }

  return (
    <div className="mb-3">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <Form.Label className="mb-0">Form fields</Form.Label>
        <Button size="sm" variant="outline-secondary" onClick={addField}>
          + Add field
        </Button>
      </div>
      {sorted.length === 0 && <p className="text-body-secondary small">No form fields on this task.</p>}
      {sorted.map((field, index) => (
        <Card key={field.key} className="mb-2">
          <Card.Body className="p-2">
            <div className="d-flex gap-2 align-items-start">
              <div className="d-flex flex-column">
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 lh-1"
                  disabled={index === 0}
                  onClick={() => moveField(field.key, 'up')}
                  aria-label={`Move field ${index + 1} up`}
                >
                  <UpDownIcon direction="up" />
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="p-0 lh-1"
                  disabled={index === sorted.length - 1}
                  onClick={() => moveField(field.key, 'down')}
                  aria-label={`Move field ${index + 1} down`}
                >
                  <UpDownIcon direction="down" />
                </Button>
              </div>
              <div className="flex-grow-1">
                <Row className="g-2">
                  <Col sm={6}>
                    <Form.Control
                      size="sm"
                      placeholder="Label"
                      value={field.label}
                      onChange={(event) => updateField(field.key, { label: event.target.value })}
                    />
                  </Col>
                  <Col sm={4}>
                    <Form.Select
                      size="sm"
                      value={field.field_type}
                      onChange={(event) => updateField(field.key, { field_type: event.target.value })}
                    >
                      {FIELD_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                  <Col sm={2} className="d-flex align-items-center">
                    <Form.Check
                      type="checkbox"
                      id={`field-required-${field.key}`}
                      label="Required"
                      checked={field.required}
                      onChange={(event) => updateField(field.key, { required: event.target.checked })}
                    />
                  </Col>
                </Row>
                {field.field_type === 'SELECT' && (
                  <Form.Control
                    size="sm"
                    className="mt-2"
                    placeholder="Options, comma-separated"
                    value={(field.options ?? []).join(', ')}
                    onChange={(event) =>
                      updateField(field.key, {
                        options: event.target.value
                          .split(',')
                          .map((option) => option.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                )}
                <Form.Control
                  size="sm"
                  className="mt-2"
                  placeholder="Help text (optional)"
                  value={field.help_text}
                  onChange={(event) => updateField(field.key, { help_text: event.target.value })}
                />
              </div>
              <Button
                variant="link"
                size="sm"
                className="text-danger p-0"
                onClick={() => removeField(field.key)}
                aria-label={`Delete field ${index + 1}`}
              >
                Delete
              </Button>
            </div>
          </Card.Body>
        </Card>
      ))}
    </div>
  )
}
