"""
Mask the raw logo render to the macOS rounded square and write the icon set Tauri wants.

  python3 docs/brand/icons.py RAW.png

Writes docs/brand/logo.png (1024, on the macOS icon grid: an 824 px body with
its soft shadow) and docs/brand/icons/: 32x32.png, 128x128.png,
128x128@2x.png, icon.png (512) and icon.icns (via iconutil).
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
raw = Image.open(sys.argv[1]).convert('RGB')

CANVAS = 1024
BODY = 824
SS = 4  # supersample the mask edge


def squircle(size, n=5.0):
    """Apple-style continuous-corner rounded square, as a superellipse mask."""
    big = size * SS
    m = Image.new('L', (big, big), 0)
    d = ImageDraw.Draw(m)
    pts = []
    import math
    for i in range(720):
        t = 2 * math.pi * i / 720
        c, s = math.cos(t), math.sin(t)
        x = abs(c) ** (2 / n) * (1 if c >= 0 else -1)
        y = abs(s) ** (2 / n) * (1 if s >= 0 else -1)
        pts.append(((x + 1) / 2 * (big - 1), (y + 1) / 2 * (big - 1)))
    d.polygon(pts, fill=255)
    return m.resize((size, size), Image.LANCZOS)


body = raw.resize((BODY, BODY), Image.LANCZOS)
mask = squircle(BODY)

# A hairline of light on the top edge and a darker rim, so the tile reads as an object.
rim = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))
body_rgba = body.convert('RGBA')
dark = Image.new('RGBA', (BODY, BODY), (0, 0, 0, 90))
body_rgba = Image.composite(Image.alpha_composite(body_rgba, dark), body_rgba, rim)
body_rgba.putalpha(mask)

canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
off = (CANVAS - BODY) // 2
shadow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
sh_mask = Image.new('L', (CANVAS, CANVAS), 0)
sh_mask.paste(mask, (off, off + 10))
shadow.putalpha(sh_mask.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.5)))
canvas = Image.alpha_composite(canvas, shadow)
canvas.alpha_composite(body_rgba, (off, off))
canvas.save(os.path.join(HERE, 'logo.png'), optimize=True)

icons = os.path.join(HERE, 'icons')
os.makedirs(icons, exist_ok=True)


def at(size):
    return canvas.resize((size, size), Image.LANCZOS)


at(32).save(os.path.join(icons, '32x32.png'))
at(128).save(os.path.join(icons, '128x128.png'))
at(256).save(os.path.join(icons, '128x128@2x.png'))
at(512).save(os.path.join(icons, 'icon.png'))

tmp = tempfile.mkdtemp()
iconset = os.path.join(tmp, 'icon.iconset')
os.makedirs(iconset)
for size in (16, 32, 128, 256, 512):
    at(size).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
    at(size * 2).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(icons, 'icon.icns')], check=True)
shutil.rmtree(tmp)
print('wrote logo.png and icons/')
