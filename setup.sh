#!/usr/bin/env bash
# First-time setup for Altrium CRM (macOS/Linux). Safe to re-run — every step
# checks whether it's already done before doing it.
#
# Usage:  ./setup.sh
# If it's not executable yet:  chmod +x setup.sh && ./setup.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() {
    echo ""
    echo "==> $1"
}

fail() {
    echo "$1" >&2
    exit 1
}

get_env_value() {
    # get_env_value <path> <key> <default>
    local path="$1" key="$2" default="$3"
    if [ -f "$path" ]; then
        local value
        value=$(grep -m1 "^${key}=" "$path" | cut -d'=' -f2- || true)
        if [ -n "$value" ]; then
            echo "$value"
            return
        fi
    fi
    echo "$default"
}

set_env_value() {
    # set_env_value <path> <key> <value> -- replaces an existing KEY=... line
    # in place, or appends one if the key isn't there yet.
    local path="$1" key="$2" value="$3"
    if grep -q "^${key}=" "$path"; then
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "$path"
        rm -f "${path}.bak"
    else
        printf '%s=%s\n' "$key" "$value" >> "$path"
    fi
}

set_url_port() {
    # set_url_port <path> <key> <new_port> -- replaces just the :<port>
    # segment of a URL value (e.g. BACKEND_URL or DATABASE_URL), leaving
    # scheme/user/pass/host/db name untouched. Delimiter is # (not |) since
    # the pattern itself uses | for alternation.
    local path="$1" key="$2" new_port="$3"
    sed -i.bak -E "s#^(${key}=.*):[0-9]+(/|\$)#\1:${new_port}\2#" "$path"
    rm -f "${path}.bak"
}

get_port_from_url() {
    # get_port_from_url <url> <default>
    local url="$1" default="$2"
    if [[ "$url" =~ :([0-9]+)(/|$) ]]; then
        echo "${BASH_REMATCH[1]}"
    else
        echo "$default"
    fi
}

# -- port availability --------------------------------------------------

port_bindable() {
    # The real test: can something actually listen here? Covers "another
    # process already has it" the same way Docker's own bind attempt would
    # fail ("Bind for 0.0.0.0:<port> failed: port is already allocated").
    # There's no Hyper-V-style reserved-range concept to check outside
    # Windows, so this alone determines usability here.
    python3 -c "
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind(('0.0.0.0', $1))
    s.close()
    sys.exit(0)
except OSError:
    sys.exit(1)
" 2>/dev/null
}

resolve_port() {
    # resolve_port <desired_port> <scan_start> <label>
    # Prints progress to stderr and the chosen port (only) to stdout, so
    # callers can do: chosen=$(resolve_port ...)
    local desired_port="$1" scan_start="$2" label="$3"

    if port_bindable "$desired_port"; then
        echo "  ${label}: ${desired_port}" >&2
        echo "$desired_port"
        return
    fi

    local candidate="$scan_start"
    local attempts=0
    while [ "$attempts" -lt 200 ]; do
        if port_bindable "$candidate"; then
            echo "  Port ${desired_port} (${label}) is already in use by another process. Using ${candidate} instead." >&2
            echo "$candidate"
            return
        fi
        candidate=$((candidate + 1))
        attempts=$((attempts + 1))
    done
    fail "Could not find a free port for ${label} after scanning from ${scan_start}."
}

root_env="$repo_root/.env"
backend_env="$repo_root/backend/.env"
frontend_env="$repo_root/frontend/.env"

# -- 1. Environment files --------------------------------------------------
step "Environment files"
copy_env_if_missing() {
    local example="$1" target="$2"
    if [ -f "$target" ]; then
        echo "  $target already exists, skipping."
    else
        cp "$example" "$target"
        echo "  Created $target."
    fi
}
copy_env_if_missing "$repo_root/.env.example" "$root_env"
copy_env_if_missing "$repo_root/backend/.env.example" "$backend_env"
copy_env_if_missing "$repo_root/frontend/.env.example" "$frontend_env"

# -- 2. Docker check (needed before we can check for an existing container) -
step "Docker"
if ! docker info >/dev/null 2>&1; then
    fail "Docker doesn't appear to be running (or isn't installed). Start Docker Desktop (or the Docker daemon), then re-run this script."
fi
echo "  Docker is running."

# -- 3. Ports ------------------------------------------------------------
step "Ports"

existing_container=$(docker ps -a --filter "name=^altrium-crm-db-1$" --format "{{.Names}}" 2>/dev/null | head -n1 || true)
db_port=$(get_env_value "$root_env" DB_PORT 5432)
if [ "$existing_container" = "altrium-crm-db-1" ]; then
    echo "  Postgres: ${db_port} (reusing existing altrium-crm-db-1 container)"
else
    new_db_port=$(resolve_port "$db_port" 15432 "Postgres")
    if [ "$new_db_port" != "$db_port" ]; then
        set_env_value "$root_env" DB_PORT "$new_db_port"
        set_url_port "$backend_env" DATABASE_URL "$new_db_port"
        set_env_value "$backend_env" DB_PORT "$new_db_port"
    fi
    db_port="$new_db_port"
fi

backend_url=$(get_env_value "$frontend_env" BACKEND_URL "http://localhost:9000")
django_port=$(get_port_from_url "$backend_url" 9000)
new_django_port=$(resolve_port "$django_port" $((django_port + 1)) "Django")
if [ "$new_django_port" != "$django_port" ]; then
    set_url_port "$frontend_env" BACKEND_URL "$new_django_port"
fi
django_port="$new_django_port"

frontend_port=$(get_env_value "$frontend_env" FRONTEND_PORT 3000)
new_frontend_port=$(resolve_port "$frontend_port" $((frontend_port + 1)) "Vite")
if [ "$new_frontend_port" != "$frontend_port" ]; then
    set_env_value "$frontend_env" FRONTEND_PORT "$new_frontend_port"
fi
frontend_port="$new_frontend_port"

# -- 4. SECRET_KEY -----------------------------------------------------------
step "Django SECRET_KEY"
current_value=$(grep -m1 '^SECRET_KEY=' "$backend_env" 2>/dev/null | cut -d'=' -f2- || true)

if [ -z "$current_value" ] || [ "$current_value" = "replace-with-a-50-character-random-string" ]; then
    secret_key=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 50)
    if grep -q '^SECRET_KEY=' "$backend_env"; then
        sed -i.bak "s|^SECRET_KEY=.*|SECRET_KEY=${secret_key}|" "$backend_env"
        rm -f "${backend_env}.bak"
    else
        printf 'SECRET_KEY=%s\n' "$secret_key" >> "$backend_env"
    fi
    echo "  Generated a random SECRET_KEY."
else
    echo "  SECRET_KEY already set, leaving it alone."
fi

# -- 5. Docker Compose / Postgres --------------------------------------------
step "Database"
cd "$repo_root"
echo "  Starting the database container..."
docker compose up -d

echo "  Waiting for Postgres to accept connections..."
ready=false
for _ in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U altrium -d altrium >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 2
done
if [ "$ready" != true ]; then
    fail "Postgres never became ready after 60 seconds. Check 'docker compose logs db'."
fi
echo "  Postgres is ready."

# -- 6. Backend virtual environment + requirements ---------------------------
step "Backend"
venv_dir="$repo_root/backend/.venv"
venv_python="$venv_dir/bin/python"
if [ -x "$venv_python" ]; then
    echo "  Virtual environment already exists."
else
    echo "  Creating virtual environment..."
    python3 -m venv "$venv_dir" || fail "Failed to create the virtual environment. Is Python 3.12 installed and on PATH?"
fi

echo "  Installing requirements..."
"$venv_python" -m pip install --quiet --upgrade pip
"$venv_python" -m pip install --quiet -r "$repo_root/backend/requirements.txt"

# -- 7. Migrate + seed demo data ---------------------------------------------
echo "  Running migrations..."
"$venv_python" "$repo_root/backend/manage.py" migrate

echo "  Seeding demo data..."
"$venv_python" "$repo_root/backend/manage.py" seed_demo

# -- 8. Frontend dependencies -------------------------------------------------
step "Frontend"
echo "  Running npm install..."
(cd "$repo_root/frontend" && npm install)

# -- 9. Done ------------------------------------------------------------------
backend_url=$(get_env_value "$frontend_env" BACKEND_URL "http://localhost:${django_port}")
backend_url="${backend_url%/}"

echo ""
echo "==> Setup complete."
echo ""
echo "Start the app with three terminals:"
echo "  docker compose up -d"
echo "  cd backend && source .venv/bin/activate && python manage.py runserver ${django_port}"
echo "  cd frontend && npm run dev"
echo ""
echo "Ports:"
echo "  Postgres  ${db_port}"
echo "  Django    ${django_port}"
echo "  Vite      ${frontend_port}"
echo ""
echo "URLs:"
echo "  App             http://localhost:${frontend_port}"
echo "  Django admin    ${backend_url}/admin"
echo "  API docs        ${backend_url}/api/docs"
echo ""
echo "Test logins (password: testpass123):"
echo "  rep1, rep2   Sales Rep"
echo "  mgr1         Sales Manager"
echo "  admin        System Admin (superuser)"
echo ""
