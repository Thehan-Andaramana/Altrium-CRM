import { useEffect, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import Spinner from 'react-bootstrap/Spinner'
import { Navigate, useSearchParams } from 'react-router-dom'
import { errorMessage, get, patch } from '../api'
import { useAuth } from '../AuthContext.jsx'
import AppearanceSettings, { NotificationSettings } from '../components/AppearanceSettings.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import SettingsSection, { SettingRow } from '../components/SettingsSection.jsx'
import RequirementTemplates from './RequirementTemplates.jsx'

const ALLOWED_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER', 'SYSTEM_ADMIN'])

const TABS = [
  { key: 'general', label: 'General', title: 'General' },
  { key: 'templates', label: 'Requirement Templates', title: 'Requirement Templates' },
  { key: 'appearance', label: 'Appearance', title: 'Appearance' },
  { key: 'notifications', label: 'Notifications', title: 'Notifications' },
]

export default function Settings() {
  const { user } = useAuth()
  // The sidebar links straight to a tab (Templates has its own item), and
  // the tab is part of the address so a settings page can be linked to.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const activeTab = TABS.some((tab) => tab.key === requestedTab) ? requestedTab : 'general'

  const [coldLeadDays, setColdLeadDays] = useState('')
  const [savedColdLeadDays, setSavedColdLeadDays] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)

  usePageMeta({
    title: TABS.find((tab) => tab.key === activeTab)?.title ?? 'System Settings',
    breadcrumbs: [{ label: 'System Settings' }],
  })

  useEffect(() => {
    if (!ALLOWED_ROLES.has(user?.role)) {
      return undefined
    }

    let cancelled = false

    async function fetchSettings() {
      setLoading(true)
      setLoadError(null)
      try {
        const data = await get('/api/settings/')
        if (!cancelled) {
          setColdLeadDays(String(data.cold_lead_days))
          setSavedColdLeadDays(String(data.cold_lead_days))
        }
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

  // Only General holds anything the server has to be told about. Appearance
  // and Notifications are per-browser preferences that apply as they change,
  // and Templates saves each edit through its own dialog -- so the header's
  // Save Changes is disabled on those tabs rather than pretending otherwise.
  const isDirty = activeTab === 'general' && coldLeadDays !== savedColdLeadDays
  const savesHere = activeTab === 'general'

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    setSaved(false)
    try {
      const data = await patch('/api/settings/', { cold_lead_days: Number(coldLeadDays) })
      setColdLeadDays(String(data.cold_lead_days))
      setSavedColdLeadDays(String(data.cold_lead_days))
      setSaved(true)
    } catch (err) {
      setSaveError(errorMessage(err, 'Failed to save settings.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings">
      <div className="settings__header">
        {/* Real tab semantics, not just buttons that look like tabs: each
            one announces as a tab and says whether it is the selected one. */}
        <div className="settings__tabs" role="tablist" aria-label="Settings sections">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`settings-tab-${tab.key}`}
              aria-selected={activeTab === tab.key}
              aria-controls="settings-panel"
              className={`settings__tab ${activeTab === tab.key ? 'settings__tab--active' : ''}`.trim()}
              onClick={() => setSearchParams(tab.key === 'general' ? {} : { tab: tab.key }, { replace: true })}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          disabled={!isDirty || saving}
          title={savesHere ? undefined : 'Changes on this tab apply as you make them.'}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>

      <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
      {saved && activeTab === 'general' && (
        <Alert variant="success" dismissible onClose={() => setSaved(false)}>
          Settings saved.
        </Alert>
      )}
      {saveError && <Alert variant="danger">{saveError}</Alert>}

      {activeTab === 'general' &&
        (loading ? (
          <div className="d-flex justify-content-center py-5">
            <Spinner animation="border" role="status">
              <span className="visually-hidden">Loading…</span>
            </Spinner>
          </div>
        ) : loadError ? (
          <Alert variant="danger">{loadError}</Alert>
        ) : (
          <SettingsSection
            title="Lead temperature"
            description="How long a hot lead can go without client contact before it turns cold."
          >
            <SettingRow
              label="Cold lead threshold"
              hint="Counted from the last logged client interaction."
              htmlFor="cold-lead-days"
            >
              <div className="input-group settings-input">
                <Form.Control
                  id="cold-lead-days"
                  type="number"
                  min="0"
                  value={coldLeadDays}
                  onChange={(event) => setColdLeadDays(event.target.value)}
                />
                <span className="input-group-text">days</span>
              </div>
            </SettingRow>
          </SettingsSection>
        ))}

      {activeTab === 'templates' && <RequirementTemplates />}
      {activeTab === 'appearance' && <AppearanceSettings />}
      {activeTab === 'notifications' && <NotificationSettings />}
      </div>
    </div>
  )
}
