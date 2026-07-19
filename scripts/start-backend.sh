#!/usr/bin/env bash
# Запуск Go-сервера VetClinic
# Использование: ./scripts/start-backend.sh [PORT]

set -e

cd "$(dirname "$0")/.."

PORT=${1:-8080}
export PORT="$PORT"
export ENV="${ENV:-development}"
export DB_PATH="${DB_PATH:-data/vet.db}"
export FRONTEND_DIR="${FRONTEND_DIR:-frontend}"

echo "=== VetClinic Backend ==="
echo "Port        : $PORT"
echo "DB          : $DB_PATH"
echo "Frontend    : $FRONTEND_DIR"
echo "Environment : $ENV"
echo ""

# Создаём папку data если нет
mkdir -p data

# Сборка и запуск
if [ -f "go.mod" ]; then
    echo "Building..."
    go build -o ./tmp/vetclinic ./backend/
    echo "Starting server..."
    ./tmp/vetclinic
else
    echo "ERROR: go.mod not found. Run from the project root."
    exit 1
fi
