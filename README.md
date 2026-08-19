# Altrium CRM

Customer Relationship Management and Sales Pipeline Management System.

Built as a university group project using Agile/Scrum over two sprints.

**Stack:** Django REST Framework API + React SPA + PostgreSQL

---

## Table of contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [First-time setup](#first-time-setup)
- [Running the project](#running-the-project)
- [Ports and configuration](#ports-and-configuration)
- [Project structure](#project-structure)
- [Data model](#data-model)
- [Roles and permissions](#roles-and-permissions)
- [API reference](#api-reference)
- [Testing](#testing)
- [Common tasks](#common-tasks)
- [Troubleshooting](#troubleshooting)
- [Current status](#current-status)

---

## Architecture

```
React SPA (Vite, port 3000)
        │
        │  requests to /api/* are proxied by Vite
        ▼
Django + DRF (port 8000 by default)
        │
        ▼
PostgreSQL 16 (Docker, port 5432 by default)
```

**Why the proxy matters.** Vite forwards `/api` requests to Django, so the
browser treats everything as one origin. That means no CORS configuration and
no JWT tokens — Django's normal session cookie handles authentication. The
same pattern is used in production via a `vercel.json` rewrite.

---

## Prerequisites

Install these before anything else. On Windows, `winget` handles all of them:

```powershell
winget install Git.Git
winget install Python.Python.3.12
winget install OpenJS.NodeJS.LTS
winget install Docker.DockerDesktop
```

Restart your machine after installing Docker Desktop — it needs WSL2, which
only activates on reboot.

Verify everything (in a **new** terminal, so PATH updates are picked up):

```powershell
git --version
python --version
node --version
docker --version
```

---

## First-time setup

### 1. Clone and open

```powershell
git clone https://github.com/Thehan-Andaramana/Altrium-CRM.git
cd Altrium-CRM
code .
```

### 2. Allow virtual environments to activate (Windows only, once per machine)

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Answer `Y`. Without this, PowerShell refuses to run the venv activation
script.

### 3. Create your environment files

None of these are committed — each developer makes their own from the
`.example` files.

```powershell
Copy-Item .env.example .env
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

Then open `backend/.env` and set a `SECRET_KEY` (any long random string is
fine for local development).

> **Important:** `DB_PORT` in the root `.env` and the port inside
> `DATABASE_URL` in `backend/.env` must be the same number. A mismatch means
> Docker serves the database on one port while Django knocks on another, and
> the error message won't make that obvious.

### 4. Start the database

```powershell
docker compose up -d
docker compose ps
```

Wait until STATUS shows `Up`. Docker Desktop must be running.

### 5. Set up the backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py createsuperuser
```

Your prompt should show `(.venv)` after activation. Every new terminal needs
this activation again before `manage.py` commands will work.

### 6. Set up the frontend

```powershell
cd ..\frontend
npm install
```

---

## Running the project

Three terminals, all with Docker Desktop running.

**Terminal 1 — database**

```powershell
docker compose up -d
```

**Terminal 2 — backend**

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python manage.py runserver
```

**Terminal 3 — frontend**

```powershell
cd frontend
npm run dev
```

Then open:

| URL | What it is |
|---|---|
| http://localhost:3000 | React app |
| http://localhost:8000/admin | Django admin |
| http://localhost:8000/api/docs | Swagger API documentation |

Stop a server with `Ctrl + C`. Stop the database with `docker compose down`
(your data is kept). `docker compose down -v` deletes the data too.

---

## Ports and configuration

**Defaults:** Postgres `5432`, Django `8000`, Vite `3000`.

If a port is already taken — by another project, or by a Windows reserved
range — override it. Nothing committed needs editing.

| Port | Set in | Variable |
|---|---|---|
| Postgres | root `.env` | `DB_PORT` |
| Django | command line | `python manage.py runserver 9000` |
| Vite | `frontend/.env` | `FRONTEND_PORT` |

Changing the Postgres port means updating **two** files: `DB_PORT` in the root
`.env`, and the port inside `DATABASE_URL` in `backend/.env`.

Changing the Django port means updating `BACKEND_URL` in `frontend/.env` so
the Vite proxy still finds it.

### Environment files

| File | Read by | Contains |
|---|---|---|
| `.env` (root) | Docker Compose | `DB_PORT` |
| `backend/.env` | Django | `DATABASE_URL`, `SECRET_KEY`, `DEBUG` |
| `frontend/.env` | Vite | `FRONTEND_PORT`, `BACKEND_URL` |

All three are gitignored. The matching `.env.example` files are committed and
document what's required.

---

## Project structure

```
Altrium-CRM/
├── backend/
│   ├── config/           Django settings, root urls, wsgi
│   ├── crm/              Application: models, serializers, views, permissions
│   ├── manage.py
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── src/
│   ├── vite.config.js    Dev server port + /api proxy
│   ├── package.json
│   └── .env.example
├── docker-compose.yml    PostgreSQL 16
├── .env.example
├── MEETINGS.md           Timestamped meeting and stand-up log
└── README.md
```

---

## Data model

| Model | Key fields | Relationships |
|---|---|---|
| `User` | username, `role` | Custom model extending AbstractUser |
| `Company` | name, industry, website, `owner` | Owned by a User; has many Contacts |
| `Contact` | name, email, phone, job_title | Belongs to a Company |
| `Lead` | `status` (HOT/COLD), `last_activity_at`, `assigned_to` | Links to Company, optionally Contact |
| `Deal` | `stage`, `value`, `assigned_to` | Links to Company and Contact |
| `SystemSettings` | `cold_lead_days` (default 14) | Singleton — only one row exists |

**Pipeline stages:** NEW_LEAD → CONTACTED → PROPOSAL → NEGOTIATION →
CLOSED_WON / CLOSED_LOST

---

## Roles and permissions

Five roles, set on the `User` model:

| Role | Companies and Leads |
|---|---|
| `SALES_REP` | Sees and edits only records they own or are assigned. Can create new ones — always auto-assigned to themselves. **Cannot** reassign ownership. |
| `SALES_MANAGER` | Full access to all records. Can assign and reassign accounts between reps. |
| `EXECUTIVE_MANAGER` | Full access to all records. |
| `DELIVERY_LEAD` | Read-only access to all records. |
| `SYSTEM_ADMIN` | Full access. Administrative functions. |

**Account reassignment.** When a Sales Manager changes a Company's `owner`,
all related Leads and Deals are reassigned to the new owner in a single
database transaction.

**Cold lead threshold.** Leads with no activity for `cold_lead_days` are
marked COLD. The default is 14 days, configurable at `/api/settings/` by
managers and above.

Permission rules are enforced in DRF serializers and querysets, not just in
the UI — a direct API call cannot bypass them.

---

## API reference

All endpoints require authentication via session cookie.

### Authentication

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/auth/csrf/` | Sets the `csrftoken` cookie. Call before login. |
| POST | `/api/auth/login/` | Accepts `{username, password}`. Returns `{id, username, role}`. 401 on failure. |
| POST | `/api/auth/logout/` | Clears the session. |
| GET | `/api/auth/me/` | Current user, or 401 if not logged in. |

### Resources

| Method | Endpoint | Purpose |
|---|---|---|
| GET, POST | `/api/companies/` | List and create companies |
| GET, PUT, PATCH, DELETE | `/api/companies/{id}/` | Single company |
| GET, POST | `/api/leads/` | List and create leads |
| GET, PUT, PATCH, DELETE | `/api/leads/{id}/` | Single lead |
| GET | `/api/settings/` | Read system settings |
| PATCH | `/api/settings/` | Update settings (managers and above only) |

**Filtering and search:**

```
/api/companies/?industry=IT&search=colombo
/api/leads/?status=HOT&assigned_to=3
```

Full interactive documentation at `/api/docs`.

---

## Testing

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python manage.py test crm
```

Frontend tests are not set up yet — see [Current status](#current-status).

---

## Common tasks

**After pulling changes from a teammate:**

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt    # in case dependencies changed
python manage.py migrate           # in case models changed

cd ..\frontend
npm install                        # in case packages changed
```

**After changing a model:**

```powershell
python manage.py makemigrations
python manage.py migrate
```

**Reset the database completely:**

```powershell
docker compose down -v
docker compose up -d
cd backend
python manage.py migrate
python manage.py createsuperuser
```

**Adding a package:**

```powershell
# backend
pip install <package>
pip freeze > requirements.txt

# frontend
npm install <package>
```

Commit the updated `requirements.txt` or `package.json` so teammates get it.

---

## Troubleshooting

### `ports are not available` when starting Docker

Windows reserves TCP port ranges for Hyper-V/WSL2, and **these ranges change
on every reboot**. If your port falls inside one, Docker can't bind to it.

Check the current reserved ranges:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Pick a port outside every listed range and set it in the root `.env`
(`DB_PORT`), then update `DATABASE_URL` in `backend/.env` to match.

Ports above 15000 are usually safe.

### Django can't connect: `Connection refused`

Three things to check, in order:

1. Is Docker Desktop running?
2. Is the container up? `docker compose ps` should show STATUS `Up`
3. Do `DB_PORT` (root `.env`) and `DATABASE_URL` (`backend/.env`) use the
   same port?

Number 3 is the most common cause.

### Vite fails with `EACCES: permission denied`

Same Windows reserved-range problem as above. Set `FRONTEND_PORT` in
`frontend/.env` to a port outside the excluded ranges.

### `django-admin` or `manage.py` not recognised

The virtual environment isn't active. Your prompt should show `(.venv)`:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
```

Every new terminal needs this.

### `python` opens the Microsoft Store

Windows' placeholder alias is intercepting the command. Search "Manage app
execution aliases" in the Start menu and turn off `python.exe` and
`python3.exe`.

### 404 at `http://localhost:8000/`

Expected. This is an API-only backend — nothing is mapped to the root path.
Use `/admin` or `/api/docs`. Django's 404 page lists every route it knows
about, which is useful for checking whether an endpoint registered.

---

## Current status

**Sprint 1, in progress.**

### Working

- PostgreSQL running in Docker
- Custom User model with five roles
- Company, Contact, Lead, Deal, SystemSettings models
- Django admin with CRUD for all models
- Session authentication endpoints for the React SPA
- Company and Lead APIs with role-based access control
- Configurable cold-lead threshold
- Account reassignment with cascade to related records
- Swagger API documentation at `/api/docs`

### Not built yet

- React pages — the frontend is scaffolded (Vite, Bootstrap, React Router
  installed) but no application pages exist yet
- Contact and Deal API endpoints
- Interaction logging
- Audit logging via `django-auditlog` (installed, not yet wired up)
- Automated cold-lead job (planned as a GitHub Actions scheduled workflow)
- File uploads via Cloudinary — deferred to Sprint 2
- Frontend tests with Vitest
- CI pipeline
- Deployment to Vercel and Render

### Notes for whoever picks this up

- Check `MEETINGS.md` for the most recent handover notes.
- `CLAUDE.md` in the repo root gives Claude Code context on the project —
  worth keeping current as the codebase grows.
- Read the diffs before accepting AI-generated code. The permission rules
  in particular have been hand-verified; a plausible-looking change can
  silently reintroduce a privilege escalation.
