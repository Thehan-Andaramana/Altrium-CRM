import Card from 'react-bootstrap/Card'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import { useTheme } from '../ThemeContext.jsx'

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const FONT_SIZE_OPTIONS = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
]

const NAV_VARIANT_OPTIONS = [
  { value: 'top', label: 'Top navbar' },
  { value: 'sidebar', label: 'Sidebar' },
]

const CARD_STYLE_OPTIONS = [
  { value: 'elevated', label: 'Elevated' },
  { value: 'flat', label: 'Flat' },
  { value: 'bordered', label: 'Bordered' },
]

function RadioGroup({ legend, name, options, value, onChange }) {
  return (
    <fieldset className="mb-4">
      <legend className="h6">{legend}</legend>
      {options.map((option) => (
        <Form.Check
          key={option.value}
          type="radio"
          id={`${name}-${option.value}`}
          name={name}
          label={option.label}
          checked={value === option.value}
          onChange={() => onChange(option.value)}
        />
      ))}
    </fieldset>
  )
}

export default function Preferences() {
  const {
    theme,
    setTheme,
    fontSize,
    setFontSize,
    density,
    setDensity,
    navVariant,
    setNavVariant,
    cardStyle,
    setCardStyle,
  } = useTheme()

  return (
    <Container style={{ maxWidth: '32rem' }}>
      <h1 className="h3 mb-3">Preferences</h1>
      <Card>
        <Card.Body>
          <RadioGroup
            legend="Theme"
            name="theme"
            options={THEME_OPTIONS}
            value={theme}
            onChange={setTheme}
          />
          <RadioGroup
            legend="Font size"
            name="font-size"
            options={FONT_SIZE_OPTIONS}
            value={fontSize}
            onChange={setFontSize}
          />
          <RadioGroup
            legend="Density"
            name="density"
            options={DENSITY_OPTIONS}
            value={density}
            onChange={setDensity}
          />
          <RadioGroup
            legend="Navigation style"
            name="nav-variant"
            options={NAV_VARIANT_OPTIONS}
            value={navVariant}
            onChange={setNavVariant}
          />
          <RadioGroup
            legend="Card style"
            name="card-style"
            options={CARD_STYLE_OPTIONS}
            value={cardStyle}
            onChange={setCardStyle}
          />
        </Card.Body>
      </Card>
    </Container>
  )
}