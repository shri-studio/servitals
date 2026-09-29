#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# The app icons (sub-project 4f-2), drawn from the favicon's four bars with the
# Python standard library only: www/icons/icon-192.png, icon-512.png and
# icon-maskable-512.png (content inside the 80 % safe zone). Run from the repo root.
import struct
import zlib

BG = (0x0b, 0x0e, 0x13)
BAR = (0x6b, 0xd8, 0x8a)
# the favicon on its 16 x 16 grid: (x, y, width, height)
BARS = [(2, 9, 2, 5), (5, 6, 2, 8), (8, 3, 2, 11), (11, 7, 2, 7)]


def png(path, size, inset):
    """inset: the share of each side left empty around the 16-unit drawing"""
    pad = size * inset
    unit = (size - 2 * pad) / 16
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")   # filter type 0 for every row
        for x in range(size):
            gx, gy = (x + 0.5 - pad) / unit, (y + 0.5 - pad) / unit
            on = any(bx <= gx < bx + bw and by <= gy < by + bh for bx, by, bw, bh in BARS)
            row += bytes(BAR if on else BG)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", raw))
        f.write(chunk(b"IEND", b""))


png("www/icons/icon-192.png", 192, 0.06)
png("www/icons/icon-512.png", 512, 0.06)
png("www/icons/icon-maskable-512.png", 512, 0.18)   # the bars stay inside the maskable safe zone
print("icons: www/icons/icon-192.png, icon-512.png, icon-maskable-512.png")
