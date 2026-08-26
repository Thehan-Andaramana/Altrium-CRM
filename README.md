# Altrium CRM

Sales pipeline and project lifecycle management. Django REST API + React SPA + PostgreSQL.

University group project — Agile/Scrum, two sprints.

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

---

## Something broken?

**`ports are not available`** — Windows reserves TCP ranges for Hyper-V, and they
change on every reboot. Check what's blocked:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Pick a free port, set `DB_PORT` in the root `.env`, and update `DATABASE_URL` in
`backend/.env` to match. **Both files, same number** — a mismatch is the most
common cause of connection errors.

**`Connection refused`** — Docker Desktop not running, container not up
(`docker compose ps`), or the port mismatch above.

**`manage.py` not recognised** — virtual environment not active. Your prompt
should show `(.venv)`. Run `.\.venv\Scripts\Activate.ps1`.

**Vite `EACCES: permission denied`** — same port problem. Set `FRONTEND_PORT`
in `frontend/.env`.

**404 at `localhost:9000/`** — expected. It's an API-only backend; use `/admin`
or `/api/docs`.

**`python` opens the Microsoft Store** — search "Manage app execution aliases"
in the Start menu and turn off `python.exe` and `python3.exe`.

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
`python manage.py migrate`, and `npm install` — in case dependencies or models
moved.

VS Code tasks exist for all of these: `Ctrl+Shift+P` → Run Task.

---

## How it works

```
React SPA (port 3000)  ──/api/*──►  Django + DRF (port 9000)  ──►  PostgreSQL (Docker)
```

Vite proxies `/api` to Django, so the browser sees one origin. That means no
CORS setup and no JWT — Django's session cookie handles auth.

**Repo layout:**

```
backend/config/     Django settings and root urls
backend/crm/        Models, serializers, views, permissions, tests
frontend/src/       React pages, components, contexts
docker-compose.yml  PostgreSQL 16
.github/workflows/  CI — runs tests on every push
```

---

## Data model

**Company** → has many **Contacts** and **Leads**.
**Lead** → auto-creates a **Project** on save. Links to a **Deal**.
**Project** → has three phases, each with **PhaseRequirement** tasks generated
from **RequirementTemplate**.

**Phase lifecycle** — phases begin when the Lead is created, not after the deal
closes. Phase 1 is pre-sale (proposals, contracts, requirement discussion);
completing it closes the Deal as CLOSED_WON and starts Phase 2 (build). Phase 3
is client sign-off. After Phase 3, the project enters maintenance.

Phases advance only via an approved **ApprovalRequest** — the rep requests
sign-off, a manager approves.

**Hot / Cold** — a lead goes COLD after `cold_lead_days` (default 14,
configurable in Settings) with no client contact. Only interactions with outcome
RESPONDED, and completion of tasks marked `client_facing`, count as client
contact. Internal work is tracked separately as `last_internal_activity_at`.

---

## Roles

| Role | Can do |
|---|---|
| **Sales Rep** | Create and edit own leads. Read any company. Log interactions, update phase tasks, request sign-offs and archives. |
| **Sales Manager** | Everything above, plus create/edit/archive companies, leads and projects, reassign owners, confirm manager-authority tasks, approve requests, edit templates and settings. |
| **Executive Manager** | As Sales Manager. Also approves requests raised by a Sales Manager. |
| **Delivery Lead** | Read-only across all records. |
| **System Admin** | Read-only on records. Can hard-delete already-archived records. Manages templates and settings. |

Enforced in DRF permission classes and querysets — a direct API call can't
bypass them.

---

## Testing

```powershell
python manage.py test crm
```

GitHub Actions runs the full suite plus a frontend build on every push and pull
request. Check the **Actions** tab for results.

---

## Contributing

Branch per feature, PR before merge — no direct commits to `main`.

```powershell
git checkout -b feature/short-description
# work, commit
git push -u origin feature/short-description
```

Then open a pull request into `develop` on GitHub and request a reviewer.

`main` receives `develop` only when a sprint is complete and stable.

---

## Status

**Working:** auth with five roles, company/contact/lead/deal CRUD, three-phase
project tracking with manager-editable task templates and approval gates,
interaction logging with outcomes, combined activity timeline, soft archiving
with approval workflow, role-scoped dashboard, global search, dark/light theming
with font and density preferences.

**Not built:** drag-and-drop pipeline board, executive dashboards, document
uploads, deployment (dropped — runs locally, hosted on GitHub only).

**Notes for whoever picks this up:** check `MEETINGS.md` for handover notes, and
read the diff before accepting AI-generated code — the permission rules have
been hand-verified and a plausible-looking change can silently reintroduce a
privilege escalation.
