import { useTheme } from '../ThemeContext.jsx'
import SettingsSection, { SettingChoice, SettingRow, SettingToggle } from './SettingsSection.jsx'

// Appearance and notification preferences.
//
// Both are per-user and live in this browser (see ThemeContext), not on the
// server -- which is why they apply the moment they change rather than
// waiting for a save. Shared between the Preferences page and the Settings
// page's own tabs so there is one implementation of each control.

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

const CARD_STYLE_OPTIONS = [
  { value: 'elevated', label: 'Elevated' },
  { value: 'flat', label: 'Flat' },
  { value: 'bordered', label: 'Bordered' },
]

const POLL_OPTIONS = [
  { value: 1, label: 'Every minute' },
  { value: 5, label: 'Every 5 minutes' },
  { value: 15, label: 'Every 15 minutes' },
]

export default function AppearanceSettings() {
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

  return (
    <>
      <SettingsSection
        title="Theme"
        description="Applies to this browser only, and takes effect as you change it."
      >
        <SettingRow label="Colour theme">
          <SettingChoice name="theme" label="Colour theme" options={THEME_OPTIONS} value={theme} onChange={setTheme} />
        </SettingRow>
        <SettingRow label="Card style" hint="How much the cards lift off the page behind them.">
          <SettingChoice
            name="card-style"
            label="Card style"
            options={CARD_STYLE_OPTIONS}
            value={cardStyle}
            onChange={setCardStyle}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Layout" description="Sizing and spacing across every page.">
        <SettingRow label="Font size">
          <SettingChoice
            name="font-size"
            label="Font size"
            options={FONT_SIZE_OPTIONS}
            value={fontSize}
            onChange={setFontSize}
          />
        </SettingRow>
        <SettingRow label="Density" hint="Compact tightens table rows and card padding.">
          <SettingChoice
            name="density"
            label="Density"
            options={DENSITY_OPTIONS}
            value={density}
            onChange={setDensity}
          />
        </SettingRow>
        <SettingRow
          label="Collapse the sidebar"
          hint="Start with the 72px icon rail instead of the full panel."
          htmlFor="setting-sidebar-collapsed"
        >
          <SettingToggle
            id="setting-sidebar-collapsed"
            label="Collapse the sidebar"
            checked={sidebarCollapsed}
            onChange={setSidebarCollapsed}
          />
        </SettingRow>
      </SettingsSection>
    </>
  )
}

export function NotificationSettings() {
  const {
    notificationsEnabled,
    setNotificationsEnabled,
    notificationPollMinutes,
    setNotificationPollMinutes,
  } = useTheme()

  return (
    <SettingsSection
      title="Mentions and counts"
      description="The bell in the header and the counts on Approvals and Calendar. Turning these off stops the background requests, not just the badges."
    >
      <SettingRow
        label="Check for mentions"
        hint="Shows a red dot on the bell when someone has @mentioned you."
        htmlFor="setting-notifications-enabled"
      >
        <SettingToggle
          id="setting-notifications-enabled"
          label="Check for mentions"
          checked={notificationsEnabled}
          onChange={setNotificationsEnabled}
        />
      </SettingRow>
      <SettingRow label="How often" hint="Less often means fewer background requests.">
        <SettingChoice
          name="notification-poll"
          label="How often"
          options={POLL_OPTIONS}
          value={notificationPollMinutes}
          onChange={setNotificationPollMinutes}
        />
      </SettingRow>
    </SettingsSection>
  )
}
