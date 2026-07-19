#!/usr/bin/env bash
# Скрипт разработки: запускает backend с live-reload через air (если установлен)
# или обычный go run как fallback.
# Использование: ./scripts/dev.sh

set -e

cd "$(dirname "$0")/.."

export PORT="${PORT:-8080}"
export ENV="development"
export DB_PATH="${DB_PATH:-data/vet.db}"
export FRONTEND_DIR="${FRONTEND_DIR:-frontend}"

mkdir -p data tmp

echo "=== VetClinic Dev Mode ==="
echo "URL: http://localhost:$PORT"
echo ""

# Генерируем иконки если их нет
if [ ! -f "frontend/icons/icon-192.png" ]; then
    echo "Generating PWA icons..."
    python3 scripts/generate-icons.py || echo "Warning: icon generation failed (Python required)"
fi

# Live reload с air, fallback на go run
if command -v air &>/dev/null; then
    echo "Using air for live reload..."
    echo "Install air: go install github.com/air-verse/air@latest"
    air -c .air.toml 2>/dev/null || \
    air --build.cmd "go build -o ./tmp/vetclinic ./backend/" \
        --build.bin "./tmp/vetclinic" \
        --build.include_ext "go" \
        --build.exclude_dir "frontend,.gomodcache,.gocache,data,tmp"
else
    echo "Tip: install 'air' for live reload (go install github.com/air-verse/air@latest)"
    echo "Running with go run..."
    go run ./backend/
fi
