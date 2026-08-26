import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Card from 'react-bootstrap/Card'
import Container from 'react-bootstrap/Container'
import Form from 'react-bootstrap/Form'
import Spinner from 'react-bootstrap/Spinner'
import Tab from 'react-bootstrap/Tab'
import Tabs from 'react-bootstrap/Tabs'
import { Navigate } from 'react-router-dom'
import { get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'
import RequirementTemplates from './RequirementTemplates.jsx'

const ALLOWED_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

export default function Settings() {
  const { user } = useAuth()
  const [coldLeadDays, setColdLeadDays] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!ALLOWED_ROLES.has(user?.role)) {
      return
    }

    let cancelled = false

    async function fetchSettings() {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await get('/api/settings/')
        if (!cancelled) setColdLeadDays(String(data.cold_lead_days))
      } catch {
        if (!cancelled) setLoadError('Failed to load settings.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSettings()
    return () => {
      cancelled = true
    }
  }, [user])

  if (!ALLOWED_ROLES.has(user?.role)) {
    return <Navigate to="/companies" replace />
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const data = await patch('/api/settings/', { cold_lead_days: Number(coldLeadDays) })
      setColdLeadDays(String(data.cold_lead_days))
      setSaved(true)
    } catch {
      setSaveError('Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Container style={{ maxWidth: '48rem' }}>
      <h1 className="h3 mb-3">System Settings</h1>
      <Tabs defaultActiveKey="general" className="mb-3">
        <Tab eventKey="general" title="General">
          <Card>
            <Card.Body>
              {loading ? (
                <div className="d-flex justify-content-center py-4">
                  <Spinner animation="border" role="status">
                    <span className="visually-hidden">Loading…</span>
                  </Spinner>
                </div>
              ) : loadError ? (
                <Alert variant="danger">{loadError}</Alert>
              ) : (
                <Form onSubmit={handleSubmit} style={{ maxWidth: '32rem' }}>
                  {saved && <Alert variant="success">Settings saved.</Alert>}
                  {saveError && <Alert variant="danger">{saveError}</Alert>}
                  <Form.Group className="mb-3" controlId="cold-lead-days">
                    <Form.Label>Cold lead threshold (days)</Form.Label>
                    <Form.Control
                      type="number"
                      min="0"
                      value={coldLeadDays}
                      onChange={(event) => setColdLeadDays(event.target.value)}
                      required
                    />
                  </Form.Group>
                  <Button type="submit" variant="primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </Form>
              )}
            </Card.Body>
          </Card>
        </Tab>
        <Tab eventKey="templates" title="Requirement Templates">
          <RequirementTemplates />
        </Tab>
      </Tabs>
    </Container>
  )
}
