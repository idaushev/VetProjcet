#!/usr/bin/env bash
# Запуск простого HTTP-сервера для frontend (для разработки без Go-сервера)
# Использование: ./scripts/start-frontend.sh [PORT]
#
# Внимание: при этом способе работает только offline-режим (нет API).
# Для полноценной разработки используйте start-backend.sh — он обслуживает и frontend.

set -e

cd "$(dirname "$0")/.."

PORT=${1:-3000}
FRONTEND_DIR="frontend"

echo "=== VetClinic Frontend (dev server) ==="
echo "URL: http://localhost:$PORT"
echo "Dir: $FRONTEND_DIR"
echo ""
echo "Note: API requests will target http://localhost:8080 (VetAppConfig.apiBase)"
echo ""

if command -v python3 &>/dev/null; then
    cd "$FRONTEND_DIR"
    python3 -m http.server "$PORT"
elif command -v python &>/dev/null; then
    cd "$FRONTEND_DIR"
    python -m SimpleHTTPServer "$PORT"
else
    echo "ERROR: python3 not found. Install Python or use start-backend.sh instead."
    exit 1
fi
