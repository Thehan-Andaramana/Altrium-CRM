# Altrium CRM

Sales pipeline and project lifecycle management. Django REST API + React SPA + PostgreSQL.

---

## Quick start

**Prerequisites:** Docker Desktop (running), Python 3.12, Node.js, Git.

On Windows, install them in one go:

```powershell
winget install Git.Git Python.Python.3.12 OpenJS.NodeJS.LTS Docker.DockerDesktop
```

Restart your machine afterwards — Docker needs WSL2, which activates on reboot.

### Then three commands

```powershell
git clone https://github.com/Thehan-Andaramana/Altrium-CRM.git
cd Altrium-CRM
.\setup.ps1
```

On macOS or Linux, use `./setup.sh` instead.

`setup.ps1` creates the environment files, generates a secret key, starts
PostgreSQL in Docker, builds the Python virtual environment, installs both sets
of dependencies, applies migrations, and seeds the demo data including all test
users. It's safe to re-run.

> **Before running it**, make sure no virtual environment is active in your
> terminal. If your prompt shows `(.venv)`, run `deactivate` first or open a
> fresh terminal.

### Run it

VS Code: `Ctrl+Shift+P` → **Run Task** → **Start Altrium CRM**

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

### Test logins

All use password `testpass123`:

| User | Role | What they see |
|---|---|---|
| `rep1`, `rep2` | Sales Rep | Their own leads and phase tasks, read-only company access |
| `mgr1` | Sales Manager | Everything, plus approvals and template management |
| `ex1` | Executive Manager | As manager; also approves manager-raised requests |
| `admin` | System Admin | Read-only on records; Django admin, settings and templates |

The seeded data covers every visual state: an approved phase, one awaiting
approval, an overdue task, an unconfirmed manager task, hot / cold /
approaching-cold leads, and an archived company.

---

## Manual setup

Only needed if `setup.ps1` fails.

```powershell
# 1. Environment files
Copy-Item .env.example .env
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

Then edit `backend/.env` and set a real `SECRET_KEY`:

```powershell
python -c "import secrets; print(secrets.token_urlsafe(50))"
```

```powershell
# 2. Database
docker compose up -d
docker compose ps          # STATUS should read Up

# 3. Backend (Windows: run Set-ExecutionPolicy -Scope CurrentUser RemoteSigned once)
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

---

## Demo walkthrough

1. **Log in as `mgr1`** — the dashboard shows hot leads, cold leads, leads
   approaching cold, pending approvals and overdue tasks, all role-scoped.
2. **Create a company, then a lead on it** — a Project with three phases is
   created automatically, with tasks generated from the templates.
3. **Open the lead → Phases tab** — Phase 1 is IN_PROGRESS with its checklist
   and due dates.
4. **As `rep1`, complete a REP-authority task** — green tick, progress moves.
5. **Complete a MANAGER-authority task** — amber clock, no progress until
   confirmed.
6. **As `mgr1`, confirm it** — turns green, progress advances.
7. **Complete the rest, then Request sign-off** — the button disables from
   server state.
8. **As `mgr1`, approve** — Phase 1 goes COMPLETE, the Deal flips to
   CLOSED_WON, and Phase 2 starts.
9. **Activity tab** — interactions and approvals in one colour-coded timeline.
10. **Archive a lead as `rep1`** — raises an approval request; a manager
    approves and the lead archives with the reason carried over.

---

## Architecture

```
React SPA (port 3000)  ──/api/*──►  Django + DRF (port 9000)  ──►  PostgreSQL (Docker)
```

Vite proxies `/api` to Django, so the browser sees a single origin — no CORS
configuration and no JWT. Django's session cookie handles authentication, and
role permissions live in DRF permission classes.

```
backend/config/      Django settings and root urls
backend/crm/         Models, serializers, views, permissions, tests
frontend/src/        React pages, components, contexts
frontend/src/styles/ SCSS brand theme — colour and typography in _brand.scss
docker-compose.yml   PostgreSQL 16
.github/workflows/   CI — runs the test suite on every push
setup.ps1 / setup.sh One-command first-time setup
```

---

## Data model

**Company** → has many **Contacts** and **Leads**
**Lead** → has a name of its own; auto-creates a **Project** on save; links to a **Deal**
**Project** → three phases, each with **PhaseRequirement** tasks generated from **RequirementTemplate**
**ApprovalRequest** → phase sign-offs and archive requests
**ActivityEvent** → audit trail feeding the combined lead timeline
**SystemSettings** → singleton holding the cold-lead threshold

### Phase lifecycle

Phases begin when the **Lead** is created.

- **Phase 1** — pre-sale: budget proposal, client proposal confirmation,
  requirement discussion, contract papers. Completing it closes the Deal as
  CLOSED_WON and starts Phase 2.
- **Phase 2** — build: technical specification, development progress review,
  QA sign-off.
- **Phase 3** — client acceptance, final proposal signature, handover note.
- After Phase 3, the project enters **maintenance**.

A phase advances only via an **approved ApprovalRequest**. The rep requests
sign-off once all applicable tasks are confirmed; a manager approves. Rejecting
returns the phase to IN_PROGRESS.

### Tasks

Managers define the task list per phase under **Requirement Templates**, setting
for each one:

- **Confirmation authority** — REP (the rep completes it themselves) or MANAGER
  (the rep marks it done, a manager must confirm)
- **Client-facing** — whether completing it counts as client contact
- **Due after (days)** — calculated from the phase start date

Tasks marked NOT_APPLICABLE are excluded from progress. Task rows are copied
onto the Project when it is created, so editing a template affects new leads
only.

### Hot / Cold

Leads start COLD and turn HOT on client contact. Two things count as client
contact: an interaction with outcome **RESPONDED**, and completion of a task
marked **client-facing**. Internal work is tracked separately as
`last_internal_activity_at`.

`cold_lead_days` (default 14, configurable in Settings) drives the
**Approaching Cold** dashboard band, which surfaces leads within three days of
the threshold.

---

## Roles

| Role | Can do |
|---|---|
| **Sales Rep** | Create and edit leads on companies they're assigned. Read any company. Log interactions, update phase tasks, request sign-offs and archives. Cannot change lead status or reassign ownership. |
| **Sales Manager** | Create, edit and archive companies, leads and projects. Reassign owners, confirm manager-authority tasks, approve requests, change lead status, edit templates and settings. |
| **Executive Manager** | As Sales Manager. Also approves requests raised by a Sales Manager — nobody can approve their own. |
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

**119 tests** covering phase gates, the self-approval block, both task
confirmation paths, NOT_APPLICABLE exclusion, due-date calculation, archive
cascade and approval flow, dashboard role scoping, and the permission rules on
every model.

GitHub Actions runs the full suite plus a frontend build on every push and pull
request, against a PostgreSQL container built from empty — see the **Actions**
tab.

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

## Troubleshooting

**`Permission denied` creating the virtual environment** — another virtual
environment is active. Run `deactivate` or open a new terminal, then delete the
partial `.venv` folder and retry.

**`ports are not available`** — Windows reserves TCP ranges for Hyper-V, and
they change on every reboot:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Pick a port outside every listed range, set `DB_PORT` in the root `.env`, and
update `DATABASE_URL` in `backend/.env` to the same number. **Both files, same
port.** Ports above 15000 are usually safe.

**`Connection refused`** — Docker Desktop not running, container not up
(`docker compose ps`), or the port mismatch above.

**`manage.py` not recognised** — virtual environment not active. Your prompt
should show `(.venv)`.

**Vite `EACCES: permission denied`** — same reserved-port problem. Set
`FRONTEND_PORT` in `frontend/.env`.

**404 at `localhost:9000/`** — expected. This is an API-only backend; use
`/admin` or `/api/docs`.

**Lead creation fails with an IntegrityError** — the database schema is ahead of
the code, usually after switching branches. Run Task → **Reset database
(DESTRUCTIVE)**.

**`python` opens the Microsoft Store** — search "Manage app execution aliases"
in the Start menu and turn off `python.exe` and `python3.exe`.

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