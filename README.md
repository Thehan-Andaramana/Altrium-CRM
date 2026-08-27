# Altrium CRM

Sales pipeline and project lifecycle management. Django REST API + React SPA + PostgreSQL.

---

## Quick start

**You need:** Docker Desktop running, Python 3.12, Node.js, Git.

```powershell
git clone https://github.com/Thehan-Andaramana/Altrium-CRM.git
cd Altrium-CRM

# 1. Environment files (not committed — make your own)
Copy-Item .env.example .env
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env

# 2. Database
docker compose up -d

# 3. Backend
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_demo

# 4. Frontend
cd ..\frontend
npm install
```

**Then run it** — VS Code: `Ctrl+Shift+P` → Run Task → **Start Altrium CRM**.

Or three terminals:

```powershell
docker compose up -d                                                       # terminal 1
cd backend; .\.venv\Scripts\Activate.ps1; python manage.py runserver 9000  # terminal 2
cd frontend; npm run dev                                                   # terminal 3
```

| | |
|---|---|
| **App** | http://localhost:3000 |
| Django admin | http://127.0.0.1:9000/admin |
| API docs (Swagger) | http://127.0.0.1:9000/api/docs |

**Test logins** — password `testpass123`:

| User | Role |
|---|---|
| `rep1`, `rep2` | Sales Rep |
| `mgr1` | Sales Manager |
| `ex1` | Executive Manager |
| `admin` | System Admin (superuser) |

`seed_demo` creates data covering every state: an approved phase, one awaiting
approval, an overdue task, an unconfirmed manager task, hot/cold/approaching-cold
leads, and an archived company.

---

## Sprint 1 demo walkthrough

The path that exercises the core of the system:

1. **Log in as `mgr1`** → Home dashboard shows hot leads, cold leads, leads
   approaching cold, pending approvals, and overdue tasks — all role-scoped.
2. **Create a company, then a lead on it.** The lead gets a name of its own
   (e.g. "Wayne Enterprises — Q3 infrastructure upgrade"), and a Project with
   three phases is created automatically, with tasks generated from the
   manager-defined templates.
3. **Open the lead → Phases tab.** Phase 1 is IN_PROGRESS with its task
   checklist and due dates.
4. **As `rep1`, complete a REP-authority task** → green tick immediately, the
   progress bar moves.
5. **Complete a MANAGER-authority task** → amber clock, and it does *not*
   count toward progress until confirmed.
6. **As `mgr1`, confirm it** → turns green, progress advances.
7. **Complete the remaining tasks → Request sign-off.** The button disables from
   server state, so refreshing the page doesn't let you request twice.
8. **As `mgr1`, approve from Home** → Phase 1 goes COMPLETE and green, the Deal
   flips to CLOSED_WON, and Phase 2 starts.
9. **Activity tab** → interactions and approvals in one timeline, colour-coded
   by category.
10. **Archive a lead as `rep1`** → creates an approval request rather than
    archiving directly. A manager approves it and the lead archives with the
    reason carried over.

---

## Architecture

```
React SPA (port 3000)  ──/api/*──►  Django + DRF (port 9000)  ──►  PostgreSQL (Docker)
```

Vite proxies `/api` to Django, so the browser sees a single origin — no CORS
configuration and no JWT. Django's session cookie handles authentication, and
role permissions live in DRF permission classes.

**Repo layout:**

```
backend/config/     Django settings and root urls
backend/crm/        Models, serializers, views, permissions, tests
frontend/src/       React pages, components, contexts
frontend/src/styles/ SCSS brand theme — all colour/typography in _brand.scss
docker-compose.yml  PostgreSQL 16
.github/workflows/  CI — runs the test suite on every push
```

---

## Data model

**Company** → has many **Contacts** and **Leads**
**Lead** → has a name of its own; auto-creates a **Project** on save; links to a **Deal**
**Project** → three phases, each with **PhaseRequirement** tasks generated from **RequirementTemplate**
**ApprovalRequest** → phase sign-offs and archive requests
**ActivityEvent** → audit trail feeding the combined lead timeline
**SystemSettings** → singleton holding the configurable cold-lead threshold

### Phase lifecycle

Phases begin when the **Lead** is created, not after the deal closes.

- **Phase 1** — pre-sale: budget proposal, client proposal confirmation,
  requirement discussion, contract papers. Completing it closes the Deal as
  CLOSED_WON and starts Phase 2.
- **Phase 2** — build: technical specification, development progress review,
  QA sign-off.
- **Phase 3** — client acceptance, final proposal signature, handover note.
- After Phase 3, the project enters **maintenance**.

A phase can only advance via an **approved ApprovalRequest**. The rep requests
sign-off once all applicable tasks are confirmed; a manager approves. Rejecting
returns the phase to IN_PROGRESS so the rep can act on the feedback.

### Tasks

Managers define the task list per phase in **Requirement Templates**, setting for
each one:

- **Confirmation authority** — REP (the rep completes it themselves) or MANAGER
  (the rep marks it done, a manager must confirm)
- **Client-facing** — whether completing it counts as client contact for
  hot/cold purposes
- **Due after (days)** — calculated from the phase start date

Tasks marked NOT_APPLICABLE are excluded from progress entirely.

### Hot / Cold

A lead goes COLD after `cold_lead_days` (default 14, configurable in Settings)
with no client contact.

Only two things count as client contact: an interaction with outcome
**RESPONDED**, and completion of a task marked **client-facing**. Internal work
is tracked separately as `last_internal_activity_at`, so a lead that the team
has been working but the client has ignored still shows as cold — which is the
point.

---

## Roles

| Role | Can do |
|---|---|
| **Sales Rep** | Create and edit leads on companies they're assigned. Read any company. Log interactions, update phase tasks, request sign-offs and archives. Cannot change lead status or reassign ownership. |
| **Sales Manager** | Create, edit and archive companies, leads and projects. Reassign owners, confirm manager-authority tasks, approve requests, change lead status, edit templates and settings. |
| **Executive Manager** | As Sales Manager. Also approves requests raised by a Sales Manager (nobody can approve their own). |
| **Delivery Lead** | Read-only across all records. |
| **System Admin** | Read-only on records. Can hard-delete already-archived records. Manages templates and settings. |

Enforced in DRF permission classes and querysets — a direct API call cannot
bypass them.

---

## Testing

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python manage.py test crm
```

**106 tests**, covering phase gates, the self-approval block, both task
confirmation paths, NOT_APPLICABLE exclusion, due-date calculation, archive
cascade and approval flow, dashboard role scoping, and the permission rules on
every model.

GitHub Actions runs the full suite plus a frontend build on every push and pull
request, against a PostgreSQL container built from empty — see the **Actions**
tab.

---

## Something broken?

**`ports are not available`** — Windows reserves TCP ranges for Hyper-V, and they
change on every reboot:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Pick a free port, set `DB_PORT` in the root `.env`, and update `DATABASE_URL` in
`backend/.env` to match. **Both files, same number.**

**`Connection refused`** — Docker Desktop not running, container not up
(`docker compose ps`), or the port mismatch above.

**`manage.py` not recognised** — virtual environment not active. Your prompt
should show `(.venv)`.

**Vite `EACCES: permission denied`** — same port problem. Set `FRONTEND_PORT` in
`frontend/.env`.

**404 at `localhost:9000/`** — expected. API-only backend; use `/admin` or
`/api/docs`.

**Lead creation fails with an IntegrityError** — the database schema is ahead of
the code, usually after switching branches. Reset it: Run Task →
**Reset database (DESTRUCTIVE)**.

---

## Common commands

```powershell
python manage.py test crm          # run the test suite
python manage.py makemigrations    # after changing a model
python manage.py migrate
python manage.py seed_demo         # top up demo data (safe to re-run)
docker compose down -v             # wipe the database completely
```

**After pulling teammates' changes:** `pip install -r requirements.txt`,
`python manage.py migrate`, and `npm install`.

VS Code tasks exist for all of these: `Ctrl+Shift+P` → Run Task.

---

## Contributing

Branch per feature, PR before merge — no direct commits to `main`.

```powershell
git checkout -b feature/short-description
# work, commit
git push -u origin feature/short-description
```

Open a pull request into `develop` and request a reviewer. `main` receives
`develop` only when a sprint is complete and stable.

---

## Sprint 1 status

### Delivered

- Session authentication with five roles and object-level permissions
- Company, Contact, Lead and Deal management with search and filtering
- Leads carry their own name and are identifiable independently of contact
- Three-phase project lifecycle with approval gates at each sign-off
- Manager-editable requirement templates with per-task confirmation authority,
  client-facing flag and due dates
- Overdue tracking with red indicators and a dashboard card
- Interaction logging with outcomes; only RESPONDED affects lead temperature
- Combined activity timeline (interactions, approvals, audit events)
- Soft archiving with cascade, and an approval workflow for reps
- Role-scoped dashboard, global company search
- Altrium brand theme with dark/light modes, font scale and density preferences
- 106 automated tests, CI on every push

### Deferred to Sprint 2

- Drag-and-drop pipeline board
- Executive-level dashboards and reporting
- Document uploads (replaced in Sprint 1 by task-based confirmations)
- Manual hot/cold override with manager approval
- Deployment (dropped — the prototype runs locally, hosted on GitHub)

### Known scope changes from the original specification

Each of these was a deliberate decision during Sprint 1 and is documented in the
change management appendix:

1. **RBAC relaxation** — reps can read all companies, not only their own
2. **Phase lifecycle correction** — phases begin at lead creation, not after
   Closed-Won (the original Flow and Activity diagrams show the latter)
3. **Deployment dropped** — GitHub-hosted, run locally
4. **Document uploads replaced** by task-based confirmations with notes
5. **Companies visible to reps** — read-only, with edit restricted to assignment
