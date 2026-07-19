#!/usr/bin/env python3
"""
Генерирует PNG-иконки PWA для VetClinic.
Запуск: python scripts/generate-icons.py
Требует: Python 3.6+, без дополнительных зависимостей.
"""

import struct
import zlib
import os
import math

ICONS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "icons")

# Цвета (RGBA)
BG_COLOR  = (18, 22, 31, 255)    # --bg-surface: #12161f
ACC_COLOR = (46, 204, 113, 255)  # --accent:     #2ecc71
ACC_LIGHT = (46, 204, 113, 120)  # акцент с прозрачностью

def lerp_color(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(4))

def draw_icon(size):
    """Рисует логотип VetClinic: тёмный фон + зелёное пятно + кривая."""
    w = h = size
    cx = cy = w / 2
    pixels = bytearray()

    r_blob = w * 0.38   # радиус центрального пятна
    r_core = w * 0.22   # ядро

    for y in range(h):
        pixels.append(0)  # filter byte
        for x in range(w):
            dx = x - cx
            dy = y - cy
            d  = math.hypot(dx, dy)

            if d <= r_core:
                # Яркое ядро
                pixels.extend(ACC_COLOR)
            elif d <= r_blob:
                # Градиент от акцента к фону
                t = (d - r_core) / (r_blob - r_core)
                c = lerp_color(ACC_COLOR, BG_COLOR, t * 0.85)
                pixels.extend(c)
            else:
                # Фон
                pixels.extend(BG_COLOR)

    return bytes(pixels)

def encode_png(size, pixel_data):
    """Кодирует RGBA pixel_data в валидный PNG."""
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xffffffff
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', crc)

    ihdr_data = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat_data = zlib.compress(pixel_data, 9)

    return (
        b'\x89PNG\r\n\x1a\n' +
        chunk(b'IHDR', ihdr_data) +
        chunk(b'IDAT', idat_data) +
        chunk(b'IEND', b'')
    )

def main():
    os.makedirs(ICONS_DIR, exist_ok=True)

    for size, names in [
        (192, ["icon-192.png", "icon-192-maskable.png"]),
        (512, ["icon-512.png"]),
    ]:
        print(f"Generating {size}x{size}...")
        pixels = draw_icon(size)
        png    = encode_png(size, pixels)

        for name in names:
            path = os.path.join(ICONS_DIR, name)
            with open(path, "wb") as f:
                f.write(png)
            print(f"  ✓ {path} ({len(png):,} bytes)")

    print("\nGot it! PNG icons generated in frontend/icons/")
    print("Restart the server to serve them.")

if __name__ == "__main__":
    main()
