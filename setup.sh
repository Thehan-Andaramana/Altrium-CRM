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

fail() {
    echo "$1" >&2
    exit 1
}

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
copy_env_if_missing "$repo_root/.env.example" "$repo_root/.env"
copy_env_if_missing "$repo_root/backend/.env.example" "$repo_root/backend/.env"
copy_env_if_missing "$repo_root/frontend/.env.example" "$repo_root/frontend/.env"

# -- 2. SECRET_KEY -----------------------------------------------------------
step "Django SECRET_KEY"
backend_env="$repo_root/backend/.env"
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

# -- 3. Docker Compose / Postgres --------------------------------------------
step "Docker"
if ! docker info >/dev/null 2>&1; then
    fail "Docker doesn't appear to be running (or isn't installed). Start Docker Desktop (or the Docker daemon), then re-run this script."
fi

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

# -- 4. Backend virtual environment + requirements ---------------------------
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

# -- 5. Migrate + seed demo data ---------------------------------------------
echo "  Running migrations..."
"$venv_python" "$repo_root/backend/manage.py" migrate

echo "  Seeding demo data..."
"$venv_python" "$repo_root/backend/manage.py" seed_demo

# -- 6. Frontend dependencies -------------------------------------------------
step "Frontend"
echo "  Running npm install..."
(cd "$repo_root/frontend" && npm install)

# -- 7. Done ------------------------------------------------------------------
frontend_port=$(get_env_value "$repo_root/frontend/.env" FRONTEND_PORT 3000)
backend_url=$(get_env_value "$repo_root/frontend/.env" BACKEND_URL http://localhost:9000)
backend_url="${backend_url%/}"

echo ""
echo "==> Setup complete."
echo ""
echo "Start the app with three terminals:"
echo "  docker compose up -d"
echo "  cd backend && source .venv/bin/activate && python manage.py runserver 9000"
echo "  cd frontend && npm run dev"
echo ""
echo "URLs:"
echo "  App             http://localhost:${frontend_port}"
echo "  Django admin    ${backend_url}/admin"
echo "  API docs        ${backend_url}/api/docs"
echo ""
echo "Test logins (password: testpass123):"
echo "  rep1, rep2   Sales Rep"
echo "  mgr1         Sales Manager"
echo "  ex1          Executive Manager"
echo "  admin        System Admin (superuser)"
echo ""
