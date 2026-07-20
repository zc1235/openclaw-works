#!/usr/bin/env python3
"""Generate the 灵光办公助手 (Lingguang) brand icon with no third-party deps.

Renders a modern "spark of light" sparkle mark on an indigo->violet rounded
square and writes:
  - build/icon.png  (512x512, general/linux + electron-builder copy)
  - build/icon.ico  (multi-size Windows icon: exe, installer, tray)

Pure stdlib (zlib/struct) so it runs in restricted sandboxes without Pillow.
Run:  python3 apps/desktop/scripts/generate-brand-icon.py
"""

import os
import struct
import zlib

# ---- design constants -------------------------------------------------------
MASTER = 1024  # master render size; all outputs are area-downsampled from this
# indigo (top-left) -> violet (bottom-right)
C1 = (79, 91, 242)
C2 = (146, 68, 238)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_box_sdf(px, py, hw, hh, r):
    qx = abs(px) - (hw - r)
    qy = abs(py) - (hh - r)
    outx = max(qx, 0.0)
    outy = max(qy, 0.0)
    return (outx * outx + outy * outy) ** 0.5 + min(max(qx, qy), 0.0) - r


def in_astroid(dx, dy, r, e):
    if r <= 0:
        return False
    ax = abs(dx) / r
    ay = abs(dy) / r
    return (ax ** e) + (ay ** e) <= 1.0


def render_master():
    """Return (size, bytearray rgba) opaque-where-inside master image."""
    s = MASTER
    buf = bytearray(s * s * 4)
    hw = s / 2.0
    hh = s / 2.0
    radius = s * 0.235

    # main sparkle
    cx1, cy1 = s * 0.47, s * 0.50
    r1 = s * 0.335
    # secondary small sparkle (upper-right)
    cx2, cy2 = s * 0.73, s * 0.265
    r2 = s * 0.105

    for y in range(s):
        py = y + 0.5 - hh
        row = y * s * 4
        for x in range(s):
            px = x + 0.5 - hw
            idx = row + x * 4
            if rounded_box_sdf(px, py, hw, hh, radius) > 0.0:
                # outside the rounded square -> transparent
                continue
            # diagonal gradient background
            t = (x + y) / (2.0 * s)
            r = int(lerp(C1[0], C2[0], t))
            g = int(lerp(C1[1], C2[1], t))
            b = int(lerp(C1[2], C2[2], t))
            # sparkles paint white on top
            if in_astroid(x + 0.5 - cx1, y + 0.5 - cy1, r1, 0.62) or in_astroid(
                x + 0.5 - cx2, y + 0.5 - cy2, r2, 0.62
            ):
                r, g, b = WHITE
            buf[idx] = r
            buf[idx + 1] = g
            buf[idx + 2] = b
            buf[idx + 3] = 255
    return s, buf


def downsample(src_size, src, dst_size):
    """Area-average downsample with premultiplied alpha (clean edges)."""
    dst = bytearray(dst_size * dst_size * 4)
    scale = src_size / dst_size
    for dy in range(dst_size):
        y0 = int(dy * scale)
        y1 = max(int((dy + 1) * scale), y0 + 1)
        for dx in range(dst_size):
            x0 = int(dx * scale)
            x1 = max(int((dx + 1) * scale), x0 + 1)
            sa = sr = sg = sb = 0
            n = 0
            for sy in range(y0, y1):
                base = sy * src_size * 4
                for sx in range(x0, x1):
                    i = base + sx * 4
                    a = src[i + 3]
                    sr += src[i] * a
                    sg += src[i + 1] * a
                    sb += src[i + 2] * a
                    sa += a
                    n += 1
            di = (dy * dst_size + dx) * 4
            if sa > 0:
                dst[di] = min(255, sr // sa)
                dst[di + 1] = min(255, sg // sa)
                dst[di + 2] = min(255, sb // sa)
            dst[di + 3] = sa // n if n else 0
    return dst


def encode_png(size, rgba):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type 0
        raw += rgba[y * stride : (y + 1) * stride]
    idat = zlib.compress(bytes(raw), 9)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )


def encode_icns(entries):
    """entries: list of (ostype_bytes, png_bytes) -> icns container bytes."""
    body = b""
    for ostype, png in entries:
        body += ostype + struct.pack(">I", len(png) + 8) + png
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def encode_ico(images):
    """images: list of (size, png_bytes). Embeds PNG entries (Vista+)."""
    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    offset = 6 + 16 * count
    blobs = b""
    for size, png in images:
        w = 0 if size >= 256 else size
        h = 0 if size >= 256 else size
        entries += struct.pack(
            "<BBBBHHII", w, h, 0, 0, 1, 32, len(png), offset
        )
        offset += len(png)
        blobs += png
    return header + entries + blobs


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    build_dir = os.path.normpath(os.path.join(here, "..", "build"))

    print("rendering master %dx%d ..." % (MASTER, MASTER))
    ms, master = render_master()

    # PNG output (512)
    png512_rgba = downsample(ms, master, 512)
    png512 = encode_png(512, png512_rgba)
    with open(os.path.join(build_dir, "icon.png"), "wb") as f:
        f.write(png512)
    print("wrote build/icon.png (%d bytes)" % len(png512))

    # ICO output (multi-size)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    images = []
    for sz in ico_sizes:
        rgba = downsample(ms, master, sz)
        images.append((sz, encode_png(sz, rgba)))
        print("  ico layer %dx%d" % (sz, sz))
    ico = encode_ico(images)
    with open(os.path.join(build_dir, "icon.ico"), "wb") as f:
        f.write(ico)
    print("wrote build/icon.ico (%d bytes)" % len(ico))

    # ICNS output (macOS) — modern PNG-based OSTypes.
    icns_map = [
        (b"ic11", 32),   # 16@2x
        (b"ic12", 64),   # 32@2x
        (b"ic07", 128),
        (b"ic13", 256),  # 128@2x
        (b"ic08", 256),
        (b"ic14", 512),  # 256@2x
        (b"ic09", 512),
    ]
    icns_entries = []
    png_cache = {}
    for ostype, sz in icns_map:
        if sz not in png_cache:
            png_cache[sz] = encode_png(sz, downsample(ms, master, sz))
        icns_entries.append((ostype, png_cache[sz]))
    icns = encode_icns(icns_entries)
    with open(os.path.join(build_dir, "icon.icns"), "wb") as f:
        f.write(icns)
    print("wrote build/icon.icns (%d bytes)" % len(icns))


if __name__ == "__main__":
    main()
