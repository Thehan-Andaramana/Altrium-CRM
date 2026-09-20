import Container from 'react-bootstrap/Container'
import AppearanceSettings, { NotificationSettings } from '../components/AppearanceSettings.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'

// Every role gets their own appearance and notification preferences here;
// Settings shows the same controls to management alongside the system-wide
// ones. Both render the same components, so there is one implementation of
// each control rather than two that can drift.
export default function Preferences() {
  usePageMeta({ title: 'Preferences' })

  return (
    <Container className="px-0" style={{ maxWidth: '48rem' }}>
      <AppearanceSettings />
      <NotificationSettings />
    </Container>
  )
}
