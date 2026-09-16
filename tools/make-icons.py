#!/usr/bin/env python3
"""Draw the extension icons.

Chrome will not take an SVG for a toolbar icon, and pulling in Pillow just to
paint a few shapes is not worth a dependency, so this writes the PNGs directly
with the standard library. Re-run it after changing the mark:

    python3 tools/make-icons.py

The mark: a lens ring around a chevron. The chevron echoes the "go" in GoCD
without borrowing their logo, and the ring says you are looking through
something at it -- which is the whole product in one shape.
"""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"

# Deep navy in the register of GoCD's own branding, so the icon sits naturally
# beside a GoCD tab, with our green for the glyph so it is plainly a different
# thing and not a copy of their mark.
BACKDROP_TOP = (20, 26, 58)
BACKDROP_BOTTOM = (8, 11, 30)
RING = (132, 162, 210)
GLYPH = (74, 200, 96)

SUPERSAMPLE = 4  # plenty for shapes this simple


def rounded_rect(px, py, x0, y0, x1, y1, radius):
    """True inside a rounded rectangle."""
    if px < x0 or px > x1 or py < y0 or py > y1:
        return False
    cx = x0 + radius if px < x0 + radius else (x1 - radius if px > x1 - radius else px)
    cy = y0 + radius if py < y0 + radius else (y1 - radius if py > y1 - radius else py)
    if cx == px and cy == py:
        return True
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius


def disc(px, py, cx, cy, radius):
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius


def ring(px, py, cx, cy, radius, thickness):
    distance = math.hypot(px - cx, py - cy)
    return radius - thickness <= distance <= radius


def segment(px, py, x0, y0, x1, y1, thickness):
    """True within `thickness` of the line segment -- a capsule."""
    dx, dy = x1 - x0, y1 - y0
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        return disc(px, py, x0, y0, thickness)
    t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length_squared))
    return disc(px, py, x0 + t * dx, y0 + t * dy, thickness)


def blend(base, top, alpha):
    return tuple(round(b + (t - b) * alpha) for b, t in zip(base, top))


def geometry(size):
    """The mark, optically sized.

    A lens ring around a chevron: the chevron says "go", the ring says you are
    looking through something at it. At 16px the ring and the glyph each need a
    stroke around 1.5px just to exist, and two of those inside sixteen pixels
    collide into mush -- so the toolbar size drops the ring and keeps the
    chevron, which is the half that carries the identity.
    """
    s = float(size)
    centre = s / 2

    if size < 24:  # toolbar: the chevron alone, drawn boldly
        return {
            "ring": False,
            "lens_radius": 0,
            "lens_thickness": 0,
            "cx": centre + s * 0.030,
            "half_w": s * 0.150,
            "half_h": s * 0.200,
            "thickness": max(1.6, s * 0.100),
        }

    if size < 48:  # popup and menus
        return {
            "ring": True,
            "lens_radius": s * 0.36,
            "lens_thickness": max(1.6, s * 0.072),
            "cx": centre + s * 0.022,
            "half_w": s * 0.108,
            "half_h": s * 0.158,
            "thickness": max(1.6, s * 0.052),
        }

    return {  # store listing and the extensions page
        "ring": True,
        "lens_radius": s * 0.35,
        "lens_thickness": s * 0.058,
        "cx": centre + s * 0.022,
        "half_w": s * 0.104,
        "half_h": s * 0.152,
        "thickness": s * 0.044,
    }


def render(size):
    s = float(size)
    pad = s * 0.055
    outer = (pad, pad, s - pad, s - pad)
    corner = s * 0.235
    centre = s / 2

    g = geometry(size)
    cx, half_w, half_h, thickness = g["cx"], g["half_w"], g["half_h"], g["thickness"]

    # Two strokes meeting at a point: the ">" of go, drawn as a chevron rather
    # than lifted from anyone's logo.
    upper = (cx - half_w, centre - half_h, cx + half_w, centre)
    lower = (cx + half_w, centre, cx - half_w, centre + half_h)

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            samples = SUPERSAMPLE * SUPERSAMPLE
            acc_bg = acc_ring = acc_glyph = 0.0

            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    px = x + (sx + 0.5) / SUPERSAMPLE
                    py = y + (sy + 0.5) / SUPERSAMPLE

                    if not rounded_rect(px, py, *outer, corner):
                        continue
                    acc_bg += 1.0

                    if g["ring"] and ring(
                        px, py, centre, centre, g["lens_radius"], g["lens_thickness"]
                    ):
                        acc_ring += 1.0

                    if segment(px, py, *upper, thickness) or segment(px, py, *lower, thickness):
                        acc_glyph += 1.0

            alpha = acc_bg / samples
            if alpha == 0.0:
                row.extend((0, 0, 0, 0))
                continue

            colour = blend(BACKDROP_TOP, BACKDROP_BOTTOM, y / max(1, size - 1))
            colour = blend(colour, RING, acc_ring / samples)
            colour = blend(colour, GLYPH, acc_glyph / samples)

            row.extend((*colour, round(alpha * 255)))
        pixels.append(bytes(row))
    return pixels


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main():
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(OUT / f"icon{size}.png", size, render(size))
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
