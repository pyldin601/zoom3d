#!/usr/bin/env python3
"""One-off converter: docs/assets/map-reference.png -> packages/shared/src/map/level1.ts.

Python 3 stdlib only. Parameters were measured from the reference image (see the M1 plan).
The generated file is the source of truth afterwards; hand-edit it rather than re-running.
"""
import struct
import sys
import zlib
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs/assets/map-reference.png'
OUT = ROOT / 'packages/shared/src/map/level1.ts'

TW, TH = 63, 57
PITCH = 7.985
ORIGIN_X, ORIGIN_Y = 1.5, 0.4
SPAWN_PIXEL = (238, 405)  # the blue diamond
WALL_MIN_PIXELS = 8  # of the 16 central pixels
THIN_MIN_PIXELS = 4  # of the 64 tile pixels


def load_png(path):
    data = path.read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a PNG'
    i, idat = 8, b''
    while i < len(data):
        n = struct.unpack('>I', data[i:i + 4])[0]
        kind, body = data[i + 4:i + 8], data[i + 8:i + 8 + n]
        i += 12 + n
        if kind == b'IHDR':
            w, h, depth, color = struct.unpack('>IIBB', body[:10])
            interlace = body[12]
        elif kind == b'IDAT':
            idat += body
    assert depth == 8 and color == 2 and interlace == 0, 'expected 8-bit RGB, non-interlaced'
    raw = zlib.decompress(idat)
    bpp, stride = 3, w * 3
    prev, rows, p = bytearray(stride), [], 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + b) & 255
            elif f == 3:
                line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 255
        rows.append(line)
        prev = line
    return w, h, [[tuple(r[x * 3:x * 3 + 3]) for x in range(w)] for r in rows]


def pixel_class(c):
    r, g, b = c
    if max(c) <= 20:
        return None
    if b > 60 and r < 30 and g < 30:
        return '3'
    if g > r + 40 and g > b + 40:
        return 'marker'  # green secret wall
    if r > 150 and g < 80 and b < 80:
        return 'marker'  # red
    if r > 150 and g > 150 and b < 80:
        return 'marker'  # yellow
    if r > g + 10 and g > b + 10:
        return '2'
    if abs(r - g) <= 12 and abs(g - b) <= 12:
        return '1'
    return 'marker'


def neighbours(x, y):
    return [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]


def main():
    w, h, px = load_png(SRC)

    def tile_pixels(tx, ty, lo, hi):
        x0, y0 = ORIGIN_X + tx * PITCH, ORIGIN_Y + ty * PITCH
        return [px[int(y0 + j)][int(x0 + i)] for j in range(lo, hi) for i in range(lo, hi)
                if int(y0 + j) < h and int(x0 + i) < w]

    grid, thin = [], set()
    for ty in range(TH):
        row = []
        for tx in range(TW):
            classes = Counter(pixel_class(c) for c in tile_pixels(tx, ty, 2, 6))
            classes.pop(None, None)
            if sum(classes.values()) >= WALL_MIN_PIXELS:
                row.append(classes.most_common(1)[0][0])
            else:
                row.append('.')
                if sum(max(c) > 20 for c in tile_pixels(tx, ty, 0, 8)) >= THIN_MIN_PIXELS:
                    thin.add((tx, ty))
        grid.append(row)

    def majority_wall(x, y):
        types = Counter(grid[b][a] for a, b in neighbours(x, y)
                        if 0 <= a < TW and 0 <= b < TH and grid[b][a] in '123')
        return types.most_common(1)[0][0] if types else '1'

    for y in range(TH):
        for x in range(TW):
            if grid[y][x] == 'marker':
                grid[y][x] = majority_wall(x, y)

    sx, sy = int((SPAWN_PIXEL[0] - ORIGIN_X) // PITCH), int((SPAWN_PIXEL[1] - ORIGIN_Y) // PITCH)
    grid[sy][sx] = 'S'

    def bfs():
        parent = {(sx, sy): None}
        queue = deque([(sx, sy)])
        while queue:
            x, y = queue.popleft()
            if x in (0, TW - 1) or y in (0, TH - 1):
                return parent, (x, y)
            for n in neighbours(x, y):
                if n not in parent and grid[n[1]][n[0]] in '.S':
                    parent[n] = (x, y)
                    queue.append(n)
        return parent, None

    sealed = []
    while True:
        parent, leak = bfs()
        if leak is None:
            break
        path, p = [], leak
        while p:
            path.append(p)
            p = parent[p]
        candidates = [p for p in path if p in thin]  # ordered border -> spawn
        if not candidates:
            sys.exit(f'unsealable leak, path from spawn: {path[::-1]}')
        x, y = candidates[0]
        grid[y][x] = majority_wall(x, y)
        sealed.append((x, y))

    reachable = set(bfs()[0])
    for y in range(TH):
        for x in range(TW):
            if (x, y) not in reachable and grid[y][x] in '.S':
                grid[y][x] = '1'

    text = '\n'.join(''.join(r) for r in grid)
    OUT.write_text(
        '// Generated by tools/convert-map/convert.py from docs/assets/map-reference.png.\n'
        '// Source of truth from here on: edit by hand. `.` floor, `1` stone, `2` wood, `3` blue, `S` spawn.\n'
        f'export const LEVEL1 = `\n{text}\n`;\n')
    print(f'spawn ({sx}, {sy})')
    print(f'sealed {len(sealed)}: {sealed}')
    print(f'floor tiles reachable {len(reachable)}')
    print(f'wrote {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
