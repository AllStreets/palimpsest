"""Crop a raw wordmark render to its letters with even padding, and make previews on GitHub's two page colours.

  python3 docs/brand/finish.py RAW.png OUT.png [--width 1760] [--preview DIR]
"""
import sys
from PIL import Image

raw, out = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
width = int(args[args.index('--width') + 1]) if '--width' in args else 1760
preview = args[args.index('--preview') + 1] if '--preview' in args else None

im = Image.open(raw).convert('RGBA')
a = im.getchannel('A').point(lambda v: 255 if v > 235 else 0)  # letters only, not the soft shadow
x0, y0, x1, y1 = a.getbbox()
pad_x = int((x1 - x0) * 0.02)
pad_y = int((y1 - y0) * 0.16)
im = im.crop((max(0, x0 - pad_x), max(0, y0 - pad_y), min(im.width, x1 + pad_x), min(im.height, y1 + pad_y)))
h = round(im.height * width / im.width)
im = im.resize((width, h), Image.LANCZOS)
im.save(out, optimize=True)
print(out, im.size)
if preview:
    for name, bg in (('on-dark', (13, 17, 23)), ('on-light', (255, 255, 255))):
        page = Image.new('RGBA', im.size, bg + (255,))
        page.alpha_composite(im)
        page.convert('RGB').save(f'{preview}/{name}.png')
