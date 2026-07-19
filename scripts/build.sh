#!/usr/bin/env bash
# Продакшн-сборка VetClinic
# Создаёт бинарник и копирует frontend в dist/
# Использование: ./scripts/build.sh [TARGET_OS] [TARGET_ARCH]
# Примеры:
#   ./scripts/build.sh                    # текущая платформа
#   ./scripts/build.sh linux arm64        # для ARM64 Linux (Android планшет)
#   ./scripts/build.sh windows amd64     # для Windows

set -e

cd "$(dirname "$0")/.."

GOOS="${1:-$(go env GOOS)}"
GOARCH="${2:-$(go env GOARCH)}"
VERSION=$(date +%Y%m%d-%H%M)
DIST="dist"
BINARY_NAME="vetclinic"

if [ "$GOOS" = "windows" ]; then
    BINARY_NAME="vetclinic.exe"
fi

echo "=== VetClinic Build ==="
echo "Target   : $GOOS/$GOARCH"
echo "Version  : $VERSION"
echo "Output   : $DIST/"
echo ""

# Очищаем dist
rm -rf "$DIST"
mkdir -p "$DIST/frontend" "$DIST/data"

# Генерируем иконки
if [ ! -f "frontend/icons/icon-192.png" ]; then
    echo "Generating icons..."
    python3 scripts/generate-icons.py
fi

# Сборка Go
echo "Building Go binary..."
GOOS=$GOOS GOARCH=$GOARCH CGO_ENABLED=0 \
    go build \
    -ldflags="-s -w -X main.buildVersion=$VERSION" \
    -o "$DIST/$BINARY_NAME" \
    ./backend/

echo "Binary: $DIST/$BINARY_NAME ($(du -sh "$DIST/$BINARY_NAME" | cut -f1))"

# Копируем frontend
echo "Copying frontend..."
cp -r frontend/. "$DIST/frontend/"

# Создаём README для dist
cat > "$DIST/README.txt" << EOF
VetClinic $VERSION
==================
Запуск: ./$BINARY_NAME
URL: http://localhost:8080

Переменные окружения:
  PORT=8080
  DB_PATH=data/vet.db
  FRONTEND_DIR=frontend
  ENV=production
EOF

echo ""
echo "Build complete!"
echo "Contents of $DIST/:"
ls -lh "$DIST/"
