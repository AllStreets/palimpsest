"""
Mask the raw logo render to the macOS rounded square and write the icon set Tauri wants.

  python3 docs/brand/icons.py RAW.png [--small RAW_SMALL.png] [--out LOGO.png] [--icons DIR] [--no-icns]

Writes docs/brand/logo.png (1024, on the macOS icon grid: an 824 px body with
its soft shadow) and docs/brand/icons/: 16x16.png, 32x32.png, 128x128.png,
128x128@2x.png, icon.png (512) and icon.icns (via iconutil). `--small` is a
second render used for the small sizes (16, 32 and their @2x), where the
carved P reads and the tower does not; without it every size comes from
RAW.png. `--out` and `--icons` send the files elsewhere (a candidate mark,
not the shipped one). `--mark DIR` also writes the body alone (no shadow) at
the running head's and the splash's sizes.
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[2:]
OUT = args[args.index('--out') + 1] if '--out' in args else os.path.join(HERE, 'logo.png')
ICONS = args[args.index('--icons') + 1] if '--icons' in args else os.path.join(HERE, 'icons')
ICNS = '--no-icns' not in args
SMALL = args[args.index('--small') + 1] if '--small' in args else None
MARK = args[args.index('--mark') + 1] if '--mark' in args else None
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


mask = squircle(BODY)
off = (CANVAS - BODY) // 2


def on_grid(render):
    """The render on the 1024 icon grid: an 824 px body behind a soft shadow, with a darker rim so the tile reads as an object."""
    body = render.resize((BODY, BODY), Image.LANCZOS)
    rim = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(5)))
    body_rgba = body.convert('RGBA')
    dark = Image.new('RGBA', (BODY, BODY), (0, 0, 0, 90))
    body_rgba = Image.composite(Image.alpha_composite(body_rgba, dark), body_rgba, rim)
    body_rgba.putalpha(mask)
    canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    shadow = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    sh_mask = Image.new('L', (CANVAS, CANVAS), 0)
    sh_mask.paste(mask, (off, off + 10))
    shadow.putalpha(sh_mask.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.5)))
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.alpha_composite(body_rgba, (off, off))
    return canvas


canvas = on_grid(raw)
small = on_grid(Image.open(SMALL).convert('RGB')) if SMALL else canvas
canvas.save(OUT, optimize=True)
if SMALL:
    small.save(os.path.splitext(OUT)[0] + '-small.png', optimize=True)

icons = ICONS
os.makedirs(icons, exist_ok=True)

# The small mark carries 16 and 32 and their @2x (the 32 and 64 px images); the large one carries 128 and up.
SMALL_UP_TO = 64


def at(size):
    src = small if size <= SMALL_UP_TO else canvas
    return src.resize((size, size), Image.LANCZOS)


at(16).save(os.path.join(icons, '16x16.png'))
at(32).save(os.path.join(icons, '32x32.png'))
at(128).save(os.path.join(icons, '128x128.png'))
at(256).save(os.path.join(icons, '128x128@2x.png'))
at(512).save(os.path.join(icons, 'icon.png'))

if ICNS:
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, 'icon.iconset')
    os.makedirs(iconset)
    for size in (16, 32, 128, 256, 512):
        at(size).save(os.path.join(iconset, f'icon_{size}x{size}.png'))
        at(size * 2).save(os.path.join(iconset, f'icon_{size}x{size}@2x.png'))
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(icons, 'icon.icns')], check=True)
    shutil.rmtree(tmp)

if MARK:
    # The body alone, no shadow: the small mark for the running head (18 px, and @2x), the favicon (32),
    # and the large mark for the splash (128 pt, drawn @2x) and the touch icon (180).
    os.makedirs(MARK, exist_ok=True)

    def body_of(src, size):
        return src.crop((off, off, off + BODY, off + BODY)).resize((size, size), Image.LANCZOS)

    body_of(small, 18).save(os.path.join(MARK, 'mark-18.png'))
    body_of(small, 36).save(os.path.join(MARK, 'mark-18@2x.png'))
    body_of(small, 32).save(os.path.join(MARK, 'favicon-32.png'))
    body_of(canvas, 180).save(os.path.join(MARK, 'favicon-180.png'))
    body_of(canvas, 256).save(os.path.join(MARK, 'mark-256.png'))
print('wrote', OUT, 'and', icons)
