"""Draws the app icons (orange tile with a white F) as PNGs, no libraries needed."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "icons")
ORANGE = (217, 72, 15)
WHITE = (255, 255, 255)


def png(path, size, pixels):
    raw = b"".join(b"\0" + bytes(c for px in row for c in px) for row in pixels)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(data)


def icon(size, maskable=False):
    s = size
    radius = 0 if maskable else s * 0.22
    # glyph box: maskable icons keep the F inside the central safe zone
    g = 0.30 if maskable else 0.24
    x0, x1 = s * (g + 0.06), s * (1 - g)
    y0, y1 = s * g, s * (1 - g)
    stem = (x1 - x0) * 0.30
    bar = (y1 - y0) * 0.17
    rows = []
    for y in range(s):
        row = []
        for x in range(s):
            px, py = x + 0.5, y + 0.5
            # rounded tile with a little anti-aliasing
            dx = max(radius - px, 0, px - (s - radius)) if radius else 0
            dy = max(radius - py, 0, py - (s - radius)) if radius else 0
            d = (dx * dx + dy * dy) ** 0.5 - radius if (dx and dy) else (0 if radius == 0 or (dx == 0 and dy == 0) else max(dx, dy) - radius)
            a = 255 if not radius else int(max(0.0, min(1.0, 0.5 - d)) * 255) if (dx and dy) else 255
            inF = (x0 <= px <= x0 + stem and y0 <= py <= y1) or \
                  (x0 <= px <= x1 and y0 <= py <= y0 + bar) or \
                  (x0 <= px <= x1 - (x1 - x0) * 0.18 and y0 + (y1 - y0) * 0.43 <= py <= y0 + (y1 - y0) * 0.43 + bar)
            c = WHITE if inF else ORANGE
            row.append((*c, a))
        rows.append(row)
    return rows


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for size in (192, 512):
        png(os.path.join(OUT, f"icon-{size}.png"), size, icon(size))
    png(os.path.join(OUT, "icon-maskable-512.png"), 512, icon(512, maskable=True))
    print("icons written to", OUT)
