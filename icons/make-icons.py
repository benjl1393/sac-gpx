#!/usr/bin/env python3
"""Generate the extension icons. Pure stdlib — no image library required.

The mark is a switchback: the shape a mountain route makes on a map sheet,
drawn in the red the national map reserves for routes, on map paper, inside
a sheet border. Rendered at 4x and box-downsampled for antialiasing.
"""
import struct, zlib, pathlib

PAPER  = (0xFB, 0xFA, 0xF6)
INK    = (0x1A, 0x18, 0x15)
LK_RED = (0xE1, 0x26, 0x1C)

SS = 4  # supersample factor


def blend(dst, src, a):
    return tuple(round(d + (s - d) * a) for d, s in zip(dst, src))


def draw(size):
    w = h = size * SS
    px = [[PAPER for _ in range(w)] for _ in range(h)]

    # sheet border — proportionally thinner at small sizes, where it would
    # otherwise eat the space the route line needs to stay legible.
    border_ratio = 0.055 if size <= 16 else 0.085
    border = max(1, round(size * border_ratio)) * SS
    for y in range(h):
        for x in range(w):
            if x < border or y < border or x >= w - border or y >= h - border:
                px[y][x] = INK

    # Switchback polyline in normalised coords. A favicon-sized mark cannot
    # hold four turns, so drop to a single bend and let the stroke carry it.
    if size <= 16:
        pts = [(0.26, 0.80), (0.54, 0.55), (0.78, 0.24)]
        lw = max(1.0, size * 0.145) * SS
    else:
        pts = [(0.24, 0.80), (0.44, 0.62), (0.30, 0.47), (0.52, 0.33), (0.76, 0.22)]
        lw = max(1.0, size * 0.115) * SS
    pts = [(x * w, y * h) for x, y in pts]

    def stroke(p0, p1):
        x0, y0 = p0; x1, y1 = p1
        steps = int(max(abs(x1 - x0), abs(y1 - y0))) * 2 + 1
        for i in range(steps + 1):
            t = i / steps
            cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            r = lw / 2
            for yy in range(int(cy - r - 1), int(cy + r + 2)):
                for xx in range(int(cx - r - 1), int(cx + r + 2)):
                    if 0 <= xx < w and 0 <= yy < h:
                        d = ((xx - cx) ** 2 + (yy - cy) ** 2) ** 0.5
                        if d <= r:
                            px[yy][xx] = LK_RED

    for a, b in zip(pts, pts[1:]):
        stroke(a, b)

    # start marker: an ink dot at the foot of the route
    cx, cy = pts[0]
    r = max(1.2, size * (0.10 if size <= 16 else 0.085)) * SS
    for yy in range(int(cy - r - 1), int(cy + r + 2)):
        for xx in range(int(cx - r - 1), int(cx + r + 2)):
            if 0 <= xx < w and 0 <= yy < h:
                if ((xx - cx) ** 2 + (yy - cy) ** 2) ** 0.5 <= r:
                    px[yy][xx] = INK

    # box downsample
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0, 0, 0]
            for dy in range(SS):
                for dx in range(SS):
                    p = px[y * SS + dy][x * SS + dx]
                    for c in range(3):
                        acc[c] += p[c]
            row.append(tuple(v // (SS * SS) for v in acc))
        out.append(row)
    return out


def write_png(path, rows):
    size = len(rows)
    raw = b''.join(
        b'\x00' + b''.join(struct.pack('3B', *p) for p in row) for row in rows
    )

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    pathlib.Path(path).write_bytes(png)
    return len(png)


if __name__ == '__main__':
    here = pathlib.Path(__file__).parent
    for size in (16, 48, 128):
        n = write_png(here / f'icon-{size}.png', draw(size))
        print(f'  icon-{size}.png  {n} bytes')
