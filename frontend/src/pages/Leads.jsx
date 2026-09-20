import { formatDistanceToNow } from 'date-fns'
import { GitBranch } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import Alert from 'react-bootstrap/Alert'
import Badge from 'react-bootstrap/Badge'
import Button from 'react-bootstrap/Button'
import Form from 'react-bootstrap/Form'
import InputGroup from 'react-bootstrap/InputGroup'
import Spinner from 'react-bootstrap/Spinner'
import Table from 'react-bootstrap/Table'
import { Link, useSearchParams } from 'react-router-dom'
import { errorMessage, get, post } from '../api'
import { useAuth } from '../AuthContext.jsx'
import AppModal from '../components/AppModal.jsx'
import { PersonCell } from '../components/Avatar.jsx'
import FilterPanel, { FilterGroup, FilterOptions, SortChips } from '../components/FilterPanel.jsx'
import FormField, { FieldRow } from '../components/FormField.jsx'
import { usePageMeta } from '../components/PageChrome.jsx'
import SearchIcon from '../components/SearchIcon.jsx'
import { SortableTh, useSortedRows } from '../components/SortableTable.jsx'
import { LeadStatusBadge } from '../components/StatusPill.jsx'

const SEARCH_DEBOUNCE_MS = 300
// Lead create/update is restricted to SALES_MANAGER/EXECUTIVE_MANAGER --
// SYSTEM_ADMIN is read-only for leads (see ArchivableOwnedResourcePermission, backend).
const MANAGER_ROLES = new Set(['SALES_MANAGER', 'EXECUTIVE_MANAGER'])

// Sort values per column, for the card table's sortable headers. Dates sort
// on the raw timestamp, not the "3 days ago" text the cell shows.
const SORT_ACCESSORS = {
  name: (lead) => lead.name,
  company: (lead) => lead.company_name,
  contact: (lead) => lead.contact_name,
  status: (lead) => lead.status,
  phase: (lead) => (lead.maintenance ? 5 : lead.current_phase ?? null),
  last_activity: (lead) => (lead.last_activity_at ? new Date(lead.last_activity_at).getTime() : null),
  assigned_to: (lead) => lead.assigned_to_username,
}

const STATUS_FILTERS = [
  { value: 'HOT', label: 'Hot' },
  { value: 'COLD', label: 'Cold' },
]

// Phase is a filter over where each lead's project has got to; "maintenance"
// is the terminal state past Phase 4, the same split the board's columns use.
const PHASE_FILTERS = [
  { value: '1', label: 'Phase 1 Requirements' },
  { value: '2', label: 'Phase 2 Analysis' },
  { value: '3', label: 'Phase 3 Execution' },
  { value: '4', label: 'Phase 4 Sign-Off' },
  { value: 'maintenance', label: 'Maintenance' },
]

const PHASE_LABELS = Object.fromEntries(PHASE_FILTERS.map((option) => [option.value, option.label]))

const SORT_CHIPS = [
  { value: 'recent', label: 'Recently active', sort: { key: 'last_activity', direction: 'descending' } },
  { value: 'oldest', label: 'Least recently active', sort: { key: 'last_activity', direction: 'ascending' } },
  { value: 'name', label: 'Name A–Z', sort: { key: 'name', direction: 'ascending' } },
  { value: 'phase', label: 'Furthest along', sort: { key: 'phase', direction: 'descending' } },
]

function phaseKey(lead) {
  if (lead.maintenance) {
    return 'maintenance'
  }
  return lead.current_phase ? String(lead.current_phase) : null
}

function phaseLabel(lead) {
  const key = phaseKey(lead)
  return key ? PHASE_LABELS[key] ?? key : '—'
}

// Distinct, sorted values of one field across the leads on screen, each with
// how many leads carry it.
function optionsFrom(leads, pick) {
  const counts = new Map()
  for (const lead of leads) {
    const value = pick(lead)
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, count]) => ({ value, label: value, count }))
}

function NewLeadModal({ show, onHide, onCreated, companies, salesReps, canAssignRep }) {
  const [name, setName] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [contactId, setContactId] = useState('')
  const [contacts, setContacts] = useState([])
  const [loadingContacts, setLoadingContacts] = useState(false)
  const [assignedTo, setAssignedTo] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!companyId) {
      return
    }
    let cancelled = false

    async function fetchContacts() {
      setLoadingContacts(true)
      try {
        const data = await get(`/api/contacts/?company=${companyId}`)
        if (!cancelled) setContacts(data)
      } catch {
        if (!cancelled) setContacts([])
      } finally {
        if (!cancelled) setLoadingContacts(false)
      }
    }

    fetchContacts()
    return () => {
      cancelled = true
    }
  }, [companyId])

  function handleCompanyChange(value) {
    setCompanyId(value)
    setContacts([])
    setContactId('')
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const payload = { name, company: Number(companyId), contact: contactId ? Number(contactId) : null }
      // A rep creating their own lead is auto-assigned to themselves
      // server-side (see LeadSerializer.create) -- only a manager needs to
      // pick who it goes to.
      if (canAssignRep) {
        payload.assigned_to = Number(assignedTo)
      }
      await post('/api/leads/', payload)
      onCreated()
      onHide()
    } catch (err) {
      setError(errorMessage(err, 'Failed to create lead.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppModal
      show={show}
      onHide={onHide}
      size="lg"
      icon={GitBranch}
      title="New Lead"
      subtitle="Start a piece of work for a client and hand it to a rep."
      onSubmit={handleSubmit}
      actions={
        <>
          <Button variant="outline-secondary" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !name.trim() || !companyId || (canAssignRep && !assignedTo)}
          >
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      {error && <Alert variant="danger">{error}</Alert>}
      <FormField label="Name" controlId="new-lead-name" required>
        <Form.Control
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Wayne Enterprises — Q3 infrastructure upgrade"
          required
        />
      </FormField>
      <FieldRow>
        <FormField label="Company" controlId="new-lead-company" required key="company">
          <Form.Select value={companyId} onChange={(event) => handleCompanyChange(event.target.value)} required>
            <option value="">Select a company…</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </Form.Select>
        </FormField>
        <FormField label="Contact" controlId="new-lead-contact" key="contact">
          <Form.Select
            value={contactId}
            onChange={(event) => setContactId(event.target.value)}
            disabled={!companyId || loadingContacts}
          >
            <option value="">No contact</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </Form.Select>
        </FormField>
      </FieldRow>
      {canAssignRep && (
        <FormField
          label="Assigned rep"
          controlId="new-lead-assigned"
          required
          hint="A lead is always carried by a sales rep."
        >
          <Form.Select value={assignedTo} onChange={(event) => setAssignedTo(event.target.value)} required>
            <option value="">Select a rep…</option>
            {salesReps.map((rep) => (
              <option key={rep.id} value={rep.id}>
                {rep.username}
              </option>
            ))}
          </Form.Select>
        </FormField>
      )}
    </AppModal>
  )
}

export default function Leads() {
  const { user } = useAuth()
  const canAssignRep = MANAGER_ROLES.has(user?.role)
  // A rep can create a lead too, just scoped to companies they're connected
  // to (see LeadSerializer.validate on the backend) -- the company dropdown
  // below is filtered to match via ?mine=true.
  const canCreate = canAssignRep || user?.role === 'SALES_REP'

  // The dashboard's stat cards link in as /leads?status=HOT, which seeds the
  // rail's status filter -- read once, since it is a starting point rather
  // than something the rail then writes back to the URL.
  const [searchParams] = useSearchParams()
  const initialStatus = searchParams.get('status')

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [companies, setCompanies] = useState([])
  const [salesReps, setSalesReps] = useState([])
  const [showNewModal, setShowNewModal] = useState(false)

  // Status, phase, rep and PM are all applied to the list the server already
  // returned, rather than four more query parameters. The API filters leads
  // by status but not by phase, and the pipeline is an unpaginated list, so
  // filtering one way for one field and another way for three would be a
  // seam with nothing behind it. Search and "show archived" stay
  // server-side, where they change *which* records come back at all.
  const [statusFilter, setStatusFilter] = useState(() => (initialStatus ? [initialStatus] : []))
  const [phaseFilter, setPhaseFilter] = useState([])
  const [repFilter, setRepFilter] = useState([])
  const [pmFilter, setPmFilter] = useState([])

  const { rows: sortedLeads, sort, setSort, toggle: toggleSort } = useSortedRows(leads, SORT_ACCESSORS)

  usePageMeta({ title: 'Leads' })

  // Rep and PM options come from the leads on screen, so the rail only ever
  // offers a filter that would actually narrow anything.
  const repOptions = useMemo(() => optionsFrom(leads, (lead) => lead.assigned_to_username), [leads])
  const pmOptions = useMemo(() => optionsFrom(leads, (lead) => lead.project_manager_username), [leads])

  const visibleLeads = useMemo(
    () =>
      sortedLeads.filter(
        (lead) =>
          (statusFilter.length === 0 || statusFilter.includes(lead.status))
          && (phaseFilter.length === 0 || phaseFilter.includes(phaseKey(lead)))
          && (repFilter.length === 0 || repFilter.includes(lead.assigned_to_username))
          && (pmFilter.length === 0 || pmFilter.includes(lead.project_manager_username)),
      ),
    [sortedLeads, statusFilter, phaseFilter, repFilter, pmFilter],
  )

  const hasFilters =
    statusFilter.length > 0 || phaseFilter.length > 0 || repFilter.length > 0 || pmFilter.length > 0 || Boolean(sort)

  function resetFilters() {
    setStatusFilter([])
    setPhaseFilter([])
    setRepFilter([])
    setPmFilter([])
    setSort(null)
  }

  // The chips and the column headers drive one sort state between them, so
  // a chip lights up when its column is sorted that way and vice versa.
  const activeChip = sort
    ? SORT_CHIPS.find((chip) => chip.sort.key === sort.key && chip.sort.direction === sort.direction)?.value ?? null
    : null

  function handleChipChange(value) {
    const chip = SORT_CHIPS.find((option) => option.value === value)
    setSort(chip ? chip.sort : null)
  }

  useEffect(() => {
    const timeoutId = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timeoutId)
  }, [search])

  useEffect(() => {
    let cancelled = false

    async function fetchLeads() {
      setLoading(true)
      setError(null)

      const params = new URLSearchParams()
      if (debouncedSearch) {
        params.set('search', debouncedSearch)
      }
      if (includeArchived) {
        params.set('include_archived', 'true')
      }
      const query = params.toString()

      try {
        const data = await get(`/api/leads/${query ? `?${query}` : ''}`)
        if (!cancelled) setLeads(data)
      } catch {
        if (!cancelled) setError('Failed to load leads.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchLeads()
    return () => {
      cancelled = true
    }
  }, [debouncedSearch, includeArchived, refreshKey])

  useEffect(() => {
    if (!canCreate) {
      return
    }

    let cancelled = false

    async function fetchOptions() {
      try {
        // Reps only get companies they're connected to in the picker --
        // matches LeadSerializer.validate, so the dropdown never offers a
        // choice the backend would then reject.
        const companiesUrl = canAssignRep ? '/api/companies/' : '/api/companies/?mine=true'
        const [companiesData, repsData] = await Promise.all([
          get(companiesUrl),
          canAssignRep ? get('/api/users/?role=SALES_REP') : Promise.resolve([]),
        ])
        if (!cancelled) {
          setCompanies(companiesData)
          setSalesReps(repsData)
        }
      } catch {
        // New Lead modal dropdowns fall back to empty; rest of the page still works.
      }
    }

    fetchOptions()
    return () => {
      cancelled = true
    }
  }, [canCreate, canAssignRep])

  return (
    <>
      <div className="d-flex flex-column flex-sm-row align-items-sm-center gap-2 mb-3">
        <InputGroup style={{ maxWidth: '20rem' }}>
          <InputGroup.Text>
            <SearchIcon />
          </InputGroup.Text>
          <Form.Control
            type="search"
            placeholder="Search leads…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search leads"
          />
        </InputGroup>
        <Form.Switch
          id="leads-include-archived"
          label="Show archived"
          className="text-nowrap"
          checked={includeArchived}
          onChange={(event) => setIncludeArchived(event.target.checked)}
        />
        <span className="text-body-secondary small">
          {visibleLeads.length} of {leads.length}
        </span>
        {canCreate && (
          <Button variant="primary" className="ms-sm-auto" onClick={() => setShowNewModal(true)}>
            New Lead
          </Button>
        )}
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {canCreate && showNewModal && (
        <NewLeadModal
          show={showNewModal}
          onHide={() => setShowNewModal(false)}
          onCreated={() => setRefreshKey((k) => k + 1)}
          companies={companies}
          salesReps={salesReps}
          canAssignRep={canAssignRep}
        />
      )}

      <div className="pipeline-layout">
        <FilterPanel canReset={hasFilters} onReset={resetFilters}>
          <SortChips options={SORT_CHIPS} value={activeChip} onChange={handleChipChange} />

          <FilterGroup title="Status">
            <FilterOptions
              name="filter-status"
              options={STATUS_FILTERS}
              selected={statusFilter}
              onChange={setStatusFilter}
            />
          </FilterGroup>

          <FilterGroup title="Phase">
            <FilterOptions
              name="filter-phase"
              options={PHASE_FILTERS}
              selected={phaseFilter}
              onChange={setPhaseFilter}
            />
          </FilterGroup>

          <FilterGroup title="Assigned rep" defaultOpen={false}>
            <FilterOptions
              name="filter-rep"
              options={repOptions}
              selected={repFilter}
              onChange={setRepFilter}
              emptyMessage="No reps on these leads."
            />
          </FilterGroup>

          <FilterGroup title="Project manager" defaultOpen={false}>
            <FilterOptions
              name="filter-pm"
              options={pmOptions}
              selected={pmFilter}
              onChange={setPmFilter}
              emptyMessage="No project managers assigned yet."
            />
          </FilterGroup>
        </FilterPanel>

        <div>
          {loading ? (
            <div className="d-flex justify-content-center py-5">
              <Spinner animation="border" role="status">
                <span className="visually-hidden">Loading…</span>
              </Spinner>
            </div>
          ) : visibleLeads.length === 0 ? (
            <p className="text-body-secondary">No leads found.</p>
          ) : (
            <Table hover responsive className="table-cards">
              <thead>
                <tr>
                  <SortableTh columnKey="name" label="Project" sort={sort} onToggle={toggleSort} />
                  <SortableTh columnKey="company" label="Company" sort={sort} onToggle={toggleSort} />
                  <SortableTh columnKey="phase" label="Phase" sort={sort} onToggle={toggleSort} />
                  <SortableTh columnKey="status" label="Status" sort={sort} onToggle={toggleSort} />
                  <SortableTh
                    columnKey="last_activity"
                    label="Last activity"
                    sort={sort}
                    onToggle={toggleSort}
                  />
                  <SortableTh columnKey="assigned_to" label="Assigned to" sort={sort} onToggle={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {visibleLeads.map((lead) => (
                  <tr key={lead.id}>
                    <td>
                      <Link to={`/leads/${lead.id}`} className="text-decoration-none table-link-hover">
                        {lead.name}
                      </Link>
                      {lead.is_archived && (
                        <Badge bg="secondary" className="ms-2">
                          Archived
                        </Badge>
                      )}
                      {lead.contact_name && (
                        <div className="text-body-secondary small">{lead.contact_name}</div>
                      )}
                    </td>
                    <td>{lead.company_name ?? '—'}</td>
                    <td>{phaseLabel(lead)}</td>
                    <td>
                      <LeadStatusBadge status={lead.status} />
                    </td>
                    <td>
                      {lead.last_activity_at
                        ? formatDistanceToNow(new Date(lead.last_activity_at), { addSuffix: true })
                        : '—'}
                    </td>
                    <td>
                      <PersonCell
                        name={lead.assigned_to_username}
                        role={lead.assigned_to_role}
                        fallback="Unassigned"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </>
  )
}
