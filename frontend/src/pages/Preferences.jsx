import Card from 'react-bootstrap/Card'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import { usePageMeta } from '../components/PageChrome.jsx'
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

const SIDEBAR_OPTIONS = [
  { value: 'expanded', label: 'Expanded' },
  { value: 'collapsed', label: 'Icon rail' },
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
    sidebarCollapsed,
    setSidebarCollapsed,
    cardStyle,
    setCardStyle,
  } = useTheme()

  usePageMeta({ title: 'Preferences' })

  return (
    <Container className="px-0" style={{ maxWidth: '32rem' }}>
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
            legend="Sidebar"
            name="sidebar"
            options={SIDEBAR_OPTIONS}
            value={sidebarCollapsed ? 'collapsed' : 'expanded'}
            onChange={(value) => setSidebarCollapsed(value === 'collapsed')}
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