import Col from 'react-bootstrap/Col'
import Form from 'react-bootstrap/Form'
import Row from 'react-bootstrap/Row'

// A labelled field: a bold label above the control, an optional hint under
// it, and a red asterisk when the field is required.
//
// The asterisk is aria-hidden on purpose. It is a visual convention, and
// repeating it in the accessible name would have a screen reader read
// "Name star"; the control's own `required` attribute is what actually
// announces the field as required. It also means the label's accessible
// name stays exactly the word it was, so getByLabel('Name') still resolves.

export default function FormField({
  label,
  controlId,
  required = false,
  hint,
  className = '',
  children,
}) {
  return (
    <Form.Group className={`app-field ${className}`.trim()} controlId={controlId}>
      <Form.Label className="app-field__label">
        {label}
        {required && (
          <span className="app-field__required" aria-hidden="true">
            *
          </span>
        )}
      </Form.Label>
      {children}
      {hint && <Form.Text className="app-field__hint">{hint}</Form.Text>}
    </Form.Group>
  )
}

/**
 * Two fields side by side on a wide modal, stacked on a narrow one. Any
 * child that isn't paired simply takes the full width.
 */
export function FieldRow({ children, className = '' }) {
  return (
    <Row className={`g-3 ${className}`.trim()}>
      {Array.isArray(children)
        ? children.filter(Boolean).map((child, index) => (
            <Col md={6} key={child.key ?? index}>
              {child}
            </Col>
          ))
        : children}
    </Row>
  )
}
