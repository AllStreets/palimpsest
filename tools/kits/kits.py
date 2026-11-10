"""
Palimpsest architecture kits, authored in Blender from code.

Run headless (never with a UI):

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python tools/kits/kits.py -- app/public/kits/kits.glb

Every piece is built from numbers below (no randomness without a fixed seed),
so the same script always writes the same file. Pieces are authored in the
three.js frame (x right, y up, z out of the face) and written to Blender as
(x, -z, y), which the glTF exporter's +Y-up conversion turns back into
(x, y, z). Each object is one mesh named after the kit piece; app/src/city/kits.ts
reads them by name. Conventions per family of pieces:

- Masonry courses (`course_a`, `course_b`, `pier_block`, `band_course`, each
  with `.hi` and `.lo`): a unit rectangle, x -0.5..0.5, y 0..1, its face at
  z = 0 and its joints 5 cm deep (z is never scaled). The vertex colour holds
  each block's own tone. `.lo` is the same blocks as flat faces, for distance.
- Sci-fi crowns (`crown_<family>.<slot>`): plan half-width 1 at the base,
  y 0..1 for the crown's whole height, scaled to the top floors they replace.
  Slots name the tower material each part takes (wall, trim, band, vent,
  light, roof, beacon).
- Family modules (`deco_fin`, `org_rib`, `arc_pod`, ...) and ambient roof and
  massing pieces: unit boxes centred on the origin (x, y, z -0.5..0.5), so an
  instance scale is the piece's size, as the plain boxes they replace were.
"""

import math
import random
import sys

import bpy

# ---------------------------------------------------------------- mesh building


class Piece:
    """Vertices in the three.js frame, faces as index loops, optional per-vertex colour, per-face smooth flags."""

    def __init__(self):
        self.v = []
        self.f = []
        self.smooth = []
        self.col = []

    def vert(self, p, c=1.0):
        self.v.append((float(p[0]), float(p[1]), float(p[2])))
        self.col.append(c)
        return len(self.v) - 1

    def face(self, idx, smooth=False):
        self.f.append(tuple(idx))
        self.smooth.append(smooth)

    def quad(self, a, b, c, d, tone=1.0, smooth=False):
        """A quad from four points counter-clockwise seen from outside."""
        i = [self.vert(p, tone) for p in (a, b, c, d)]
        self.face(i, smooth)

    def tri(self, a, b, c, tone=1.0):
        i = [self.vert(p, tone) for p in (a, b, c)]
        self.face(i)

    def merge(self, other):
        o = len(self.v)
        self.v += other.v
        self.col += other.col
        self.f += [tuple(i + o for i in f) for f in other.f]
        self.smooth += other.smooth
        return self

    def transform(self, fn):
        self.v = [fn(p) for p in self.v]
        return self


def box(x0, x1, y0, y1, z0, z1, tone=1.0, sides=(True,) * 6):
    """An axis-aligned box. sides: +x, -x, +y, -y, +z, -z."""
    p = Piece()
    P = lambda x, y, z: (x, y, z)
    if sides[4]:
        p.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), tone)
    if sides[5]:
        p.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), tone)
    if sides[0]:
        p.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), tone)
    if sides[1]:
        p.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), tone)
    if sides[2]:
        p.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), tone)
    if sides[3]:
        p.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), tone)
    return p


def frustum(h0, h1, y0, y1, tone=1.0, top=True, bottom=False, n=4, rot=math.pi / 4):
    """A square (n=4) or polygonal frustum of half-widths h0 at y0 and h1 at y1 (corner radius for n sides)."""
    p = Piece()
    if n == 4:
        r0, r1 = h0 * math.sqrt(2), h1 * math.sqrt(2)
    else:
        r0, r1 = h0, h1
    ring = lambda r, y: [(r * math.sin(rot + 2 * math.pi * i / n), y, r * math.cos(rot + 2 * math.pi * i / n)) for i in range(n)]
    a, b = ring(r0, y0), ring(r1, y1)
    for i in range(n):
        j = (i + 1) % n
        p.quad(a[i], a[j], b[j], b[i], tone)
    if top:
        idx = [p.vert(q, tone) for q in b]
        p.face(idx)
    if bottom:
        idx = [p.vert(q, tone) for q in reversed(a)]
        p.face(idx)
    return p


def lathe(profile, segments, tone=1.0, smooth=True, phase=0.0):
    """Turns [(radius, y)] about y. Closed at the top if the last radius is 0."""
    p = Piece()
    rings = []
    for r, y in profile:
        rings.append([(r * math.sin(phase + 2 * math.pi * i / segments), y, r * math.cos(phase + 2 * math.pi * i / segments)) for i in range(segments)])
    for k in range(len(rings) - 1):
        for i in range(segments):
            j = (i + 1) % segments
            p.quad(rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i], tone, smooth)
    return p


def extrude_x(profile, x0, x1, tone=1.0, caps=True):
    """A moulding: [(z, y)] profile (bottom to top, outward is +z) swept along x from x0 to x1."""
    p = Piece()
    for k in range(len(profile) - 1):
        (z0, y0), (z1, y1) = profile[k], profile[k + 1]
        p.quad((x0, y0, z0), (x1, y0, z0), (x1, y1, z1), (x0, y1, z1), tone)
    if caps:
        back = min(z for z, _ in profile)
        for x, sgn in ((x0, -1), (x1, 1)):
            pts = [(x, y, z) for z, y in profile] + [(x, profile[-1][1], back), (x, profile[0][1], back)]
            idx = [p.vert(q, tone) for q in pts]
            p.face(idx if sgn > 0 else list(reversed(idx)))
    return p


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return lambda q: (q[0] * c + q[2] * s, q[1], -q[0] * s + q[2] * c)


def move(dx, dy, dz):
    return lambda q: (q[0] + dx, q[1] + dy, q[2] + dz)


def scale(sx, sy, sz):
    return lambda q: (q[0] * sx, q[1] * sy, q[2] * sz)


def four(piece_fn):
    """A piece built for the +z face, repeated on all four faces of a square plan."""
    out = Piece()
    for s in range(4):
        out.merge(piece_fn().transform(rot_y(s * math.pi / 2)))
    return out


# ---------------------------------------------------------------- masonry courses

JOINT = 0.05  # metres deep; z is never scaled


def block(p, x0, x1, tone, cx, cy, left=True, right=True, hi=True):
    """One block of a unit course (y 0..1), its face at z=0, chamfered down to its joints at z=-JOINT.
    The joint edges carry a darker tone (grime held in the joint), so the coursing reads as a line of shade."""
    if not hi:
        # Far: the block's face and its bed joints as flat dark strips, so the courses still read as lines of shade.
        j = cy * 0.6
        p.quad((x0, j, 0), (x1, j, 0), (x1, 1 - j, 0), (x0, 1 - j, 0), tone)
        p.quad((x0, 0, 0), (x1, 0, 0), (x1, j, 0), (x0, j, 0), tone * 0.55)
        p.quad((x0, 1 - j, 0), (x1, 1 - j, 0), (x1, 1, 0), (x0, 1, 0), tone * 0.7)
        return
    ax = x0 + (cx if left else 0)
    bx = x1 - (cx if right else 0)
    ay, by = cy, 1 - cy
    z = -JOINT
    dark = tone * 0.62

    def q(pts):
        idx = [p.vert(pt, t) for pt, t in pts]
        p.face(idx)

    q([((ax, ay, 0), tone), ((bx, ay, 0), tone), ((bx, by, 0), tone), ((ax, by, 0), tone)])
    # Top bed chamfer catches the sky; the bottom one sits in shadow.
    q([((ax, by, 0), tone), ((bx, by, 0), tone), ((x1 if right else bx, 1, z), dark), ((x0 if left else ax, 1, z), dark)])
    q([((x0 if left else ax, 0, z), dark), ((x1 if right else bx, 0, z), dark), ((bx, ay, 0), tone), ((ax, ay, 0), tone)])
    if left:
        q([((x0, 0, z), dark), ((ax, ay, 0), tone), ((ax, by, 0), tone), ((x0, 1, z), dark)])
    if right:
        q([((bx, ay, 0), tone), ((x1, 0, z), dark), ((x1, 1, z), dark), ((bx, by, 0), tone)])


def course(name, joints, edges, seed, hi, cx=0.016, cy=0.075):
    """A unit course of blocks between `joints` (x positions inside -0.5..0.5); `edges` chamfers the two ends."""
    r = random.Random(seed)
    p = Piece()
    xs = [-0.5] + joints + [0.5]
    for k in range(len(xs) - 1):
        tone = 0.8 + 0.2 * r.random()
        block(p, xs[k], xs[k + 1], tone, cx, cy, left=(k > 0 or edges), right=(k < len(xs) - 2 or edges), hi=hi)
    return p


def band_course(hi):
    """Banded brick: no head joints, only a deep horizontal channel at the top and bottom of each band."""
    p = Piece()
    block(p, -0.5, 0.5, 1.0, 0.0, 0.09, left=False, right=False, hi=hi)
    return p


# ---------------------------------------------------------------- sci-fi crowns
# Each returns {slot: Piece} in plan units (half-width 1 at the base) and y 0..1.


def crown_deco():
    """Three stepped tiers drawn in fluted piers, lit slots between them, chevron buttresses at the corners."""
    wall, trim, band, vent, roof, beacon = Piece(), Piece(), Piece(), Piece(), Piece(), Piece()
    tiers = [(1.0, 0.0, 0.42), (0.8, 0.42, 0.72), (0.6, 0.72, 1.0)]
    for t, (h, y0, y1) in enumerate(tiers):
        wall.merge(box(-h + 0.06, h - 0.06, y0, y1 - 0.03, -h + 0.06, h - 0.06, sides=(True, True, False, False, True, True)))
        n = [9, 7, 5][t]
        for s in range(4):
            def face_parts():
                f = Piece()
                for i in range(n + 1):
                    u = -h + 2 * h * i / n
                    w = 0.05 if 0 < i < n else 0.09
                    # A pier with a stepped head, standing proud of the face.
                    f.merge(box(u - w, u + w, y0, y1 - 0.05, h - 0.06, h + 0.04))
                    f.merge(box(u - w * 0.6, u + w * 0.6, y1 - 0.05, y1 - 0.01, h - 0.06, h + 0.02))
                return f
            trim.merge(face_parts().transform(rot_y(s * math.pi / 2)))
            def slots():
                f = Piece()
                for i in range(n):
                    u = -h + 2 * h * (i + 0.5) / n
                    f.merge(box(u - 0.018, u + 0.018, y0 + 0.05, y1 - 0.08, h - 0.07, h - 0.05, sides=(False, False, False, False, True, False)))
                return f
            vent.merge(slots().transform(rot_y(s * math.pi / 2)))
        # A bronze string course and a lit ledge at each tier's top.
        band.merge(frustum(h + 0.03, h + 0.03, y1 - 0.03, y1, top=True, bottom=True))
        if t < 2:
            roof.merge(box(-h, h, y1, y1 + 0.004, -h, h, sides=(False, False, True, False, False, False)))
    # Chevron buttresses: stepped wedges climbing each corner of the lower two tiers.
    for sx in (-1, 1):
        for sz in (-1, 1):
            for k, (h, y0, y1) in enumerate(tiers[:2]):
                for j in range(3):
                    w = 0.11 - j * 0.03
                    yy0 = y0 + (y1 - y0) * j / 3
                    yy1 = y0 + (y1 - y0) * (j + 1) / 3
                    c = h - 0.02
                    band.merge(box(sx * c - w, sx * c + w, yy0, yy1, sz * c - w, sz * c + w))
    roof.merge(box(-0.6, 0.6, 0.995, 1.0, -0.6, 0.6, sides=(False, False, True, False, False, False)))
    for sx in (-1, 1):
        for sz in (-1, 1):
            beacon.merge(box(sx * 0.52 - 0.02, sx * 0.52 + 0.02, 0.975, 1.0, sz * 0.52 - 0.02, sz * 0.52 + 0.02))
    return dict(wall=wall, trim=trim, band=band, vent=vent, roof=roof, beacon=beacon)


def crown_ziggurat():
    """A stepped summit: four battered stages, a lit band under every lip, ramps up the corners, a temple on top."""
    wall, trim, vent, roof, beacon = Piece(), Piece(), Piece(), Piece(), Piece()
    stages = [(1.0, 0.86, 0.0, 0.2), (0.82, 0.68, 0.2, 0.4), (0.64, 0.5, 0.4, 0.6), (0.46, 0.34, 0.6, 0.76)]
    for k, (h0, h1, y0, y1) in enumerate(stages):
        lip = y0 + (y1 - y0) * 0.78
        wall.merge(frustum(h0, h1, y0, lip, top=False))
        # The lit band set back under the next lip, then the lip itself.
        vent.merge(frustum(h1 - 0.02, h1 - 0.02, lip, y1 - 0.03, top=False))
        trim.merge(frustum(h1 + 0.02, h1 + 0.02, y1 - 0.03, y1, top=True, bottom=True))
    # Ramps: a raised spine up each corner of the slopes.
    for s in range(4):
        def ramp():
            p = Piece()
            for (h0, h1, y0, y1) in stages:
                lip = y0 + (y1 - y0) * 0.78
                a = (h0 * 0.98, y0, h0 * 0.98)
                b = (h1 * 0.98, lip, h1 * 0.98)
                w = 0.035
                p.quad((a[0] + w, a[1], a[2] - w), (a[0] - w, a[1], a[2] + w), (b[0] - w, b[1] + 0.02, b[2] + w), (b[0] + w, b[1] + 0.02, b[2] - w))
            return p
        trim.merge(ramp().transform(rot_y(s * math.pi / 2)))
    # The temple: a block with tall lit portals, under a flat cap.
    wall.merge(box(-0.3, 0.3, 0.76, 0.97, -0.3, 0.3, sides=(True, True, False, False, True, True)))
    for s in range(4):
        def portals():
            p = Piece()
            for u in (-0.15, 0.0, 0.15):
                p.merge(box(u - 0.035, u + 0.035, 0.78, 0.93, 0.3, 0.305, sides=(False, False, False, False, True, False)))
            return p
        vent.merge(portals().transform(rot_y(s * math.pi / 2)))
    trim.merge(box(-0.36, 0.36, 0.97, 1.0, -0.36, 0.36))
    roof.merge(box(-0.32, 0.32, 1.0, 1.0, -0.32, 0.32, sides=(False, False, True, False, False, False)))
    for sx in (-1, 1):
        for sz in (-1, 1):
            beacon.merge(box(sx * 0.32 - 0.02, sx * 0.32 + 0.02, 0.975, 1.0, sz * 0.32 - 0.02, sz * 0.32 + 0.02))
    return dict(wall=wall, trim=trim, vent=vent, roof=roof, beacon=beacon)


def crown_needle():
    """An octagonal taper drawn in eight titanium blades that lean in with it, a lit ring a third of the way up."""
    wall, trim, light, roof, beacon = Piece(), Piece(), Piece(), Piece(), Piece()
    prof = [(1.0, 0.0), (0.82, 0.33), (0.6, 0.66), (0.34, 1.0)]
    for k in range(len(prof) - 1):
        wall.merge(frustum(prof[k][0], prof[k + 1][0], prof[k][1], prof[k + 1][1], n=8, rot=math.pi / 8, top=False))
    roof.merge(frustum(0.34, 0.34, 1.0, 1.0, n=8, rot=math.pi / 8, top=True))
    light.merge(frustum(0.84, 0.84, 0.3, 0.33, n=8, rot=math.pi / 8, top=False))
    light.merge(frustum(0.62, 0.62, 0.63, 0.65, n=8, rot=math.pi / 8, top=False))
    # Blades on the eight corners, standing out from the taper and following it in.
    for i in range(8):
        a = 2 * math.pi * i / 8
        def blade():
            p = Piece()
            pts = [(r, y) for r, y in prof]
            for k in range(len(pts) - 1):
                (r0, y0), (r1, y1) = pts[k], pts[k + 1]
                o0, o1 = r0 * 1.0 + 0.12, r1 * 1.0 + 0.06
                w = 0.025
                # Two faces of a thin fin, from the corner of the shaft out to its edge.
                p.quad((-w, y0, r0), (-w, y0, o0), (-w, y1, o1), (-w, y1, r1))
                p.quad((w, y0, o0), (w, y0, r0), (w, y1, r1), (w, y1, o1))
                p.quad((-w, y0, o0), (w, y0, o0), (w, y1, o1), (-w, y1, o1))
            p.quad((-w, 1.0, r1), (-w, 1.0, o1), (w, 1.0, o1), (w, 1.0, r1))
            return p
        trim.merge(blade().transform(rot_y(a)))
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        beacon.merge(box(-0.02, 0.02, 0.975, 1.0, -0.02, 0.02).transform(move(0.26 * math.sin(a), 0, 0.26 * math.cos(a))))
    return dict(wall=wall, trim=trim, light=light, roof=roof, beacon=beacon)


def crown_arcology():
    """A sky garden: a deep deck cantilevered on raking struts past the shaft, trees on it, a megaframe over it."""
    wall, trim, band, light, roof, beacon, glass = Piece(), Piece(), Piece(), Piece(), Piece(), Piece(), Piece()
    # The shaft under the deck, recessed, and the struts raking out from it.
    wall.merge(box(-0.9, 0.9, 0.0, 0.34, -0.9, 0.9, sides=(True, True, False, False, True, True)))
    for s in range(4):
        def struts():
            p = Piece()
            for u in (-0.6, 0.0, 0.6):
                w = 0.05
                a0, a1 = (u, 0.04, 0.9), (u, 0.34, 1.28)
                p.quad((u - w, a0[1], a0[2]), (u + w, a0[1], a0[2]), (u + w, a1[1], a1[2]), (u - w, a1[1], a1[2]))
                p.quad((u + w, a0[1], a0[2] - 0.06), (u - w, a0[1], a0[2] - 0.06), (u - w, a1[1] - 0.06, a1[2] - 0.06), (u + w, a1[1] - 0.06, a1[2] - 0.06))
            return p
        wall.merge(struts().transform(rot_y(s * math.pi / 2)))
    # The deck: a thick slab with a lit soffit edge.
    trim.merge(box(-1.3, 1.3, 0.34, 0.42, -1.3, 1.3))
    light.merge(box(-1.24, 1.24, 0.338, 0.34, -1.24, 1.24, sides=(False, False, False, True, False, False)))
    band.merge(box(-1.26, 1.26, 0.42, 0.47, -1.26, -1.14))
    band.merge(box(-1.26, 1.26, 0.42, 0.47, 1.14, 1.26))
    band.merge(box(-1.26, -1.14, 0.42, 0.47, -1.14, 1.14))
    band.merge(box(1.14, 1.26, 0.42, 0.47, -1.14, 1.14))
    # Trees: low faceted crowns on short trunks, in a ring round the pavilion.
    r = random.Random(7)
    for i in range(14):
        a = 2 * math.pi * i / 14 + r.random() * 0.2
        rr = 0.95 + r.random() * 0.15
        x, z = rr * math.sin(a), rr * math.cos(a)
        s = 0.09 + r.random() * 0.06
        band.merge(lathe([(0.0, 0.0), (s, s * 0.6), (s * 0.8, s * 1.4), (0.0, s * 2.0)], 6, smooth=False, phase=r.random()).transform(move(x, 0.45, z)))
    # The pavilion: a glazed room on the deck, lit, under a thin roof.
    glass.merge(box(-0.55, 0.55, 0.42, 0.66, -0.55, 0.55, sides=(True, True, False, False, True, True)))
    roof.merge(box(-0.62, 0.62, 0.66, 0.7, -0.62, 0.62))
    # The megaframe: two portal frames crossing over the deck.
    for s in range(2):
        def portal():
            p = Piece()
            for x in (-1.0, 1.0):
                p.merge(box(x - 0.07, x + 0.07, 0.42, 1.0, -0.07, 0.07))
            p.merge(box(-1.07, 1.07, 0.9, 1.0, -0.07, 0.07))
            return p
        trim.merge(portal().transform(rot_y(s * math.pi / 2)))
    # A canopy over the garden, carried on the frames: a solid roof the band can wrap, open at the sides.
    trim.merge(box(-1.07, 1.07, 0.93, 1.0, -1.07, 1.07))
    light.merge(box(-1.0, 1.0, 0.928, 0.93, -1.0, 1.0, sides=(False, False, False, True, False, False)))
    for x, z in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        beacon.merge(box(x * 1.0 - 0.025, x * 1.0 + 0.025, 0.975, 1.0, z * 1.0 - 0.025, z * 1.0 + 0.025))
    return dict(wall=wall, trim=trim, band=band, light=light, roof=roof, beacon=beacon, glass=glass)


def crown_organic():
    """A ribbed dome: the shell swells and closes in, twelve ribs follow it up to a ring, lit slits between them."""
    wall, trim, band, glass, beacon = Piece(), Piece(), Piece(), Piece(), Piece()
    prof = [(1.0, 0.0), (1.04, 0.12), (1.0, 0.3), (0.86, 0.52), (0.64, 0.74), (0.42, 0.9), (0.4, 0.9)]
    wall.merge(lathe(prof[:-1], 48))
    wall.merge(lathe([(0.4, 0.9), (0.0, 0.9)], 48, smooth=False))
    # The ring at the top, wide enough to stand as a crown.
    band.merge(lathe([(0.36, 0.9), (0.46, 0.9), (0.46, 1.0), (0.36, 1.0), (0.36, 0.9)], 48, smooth=False))
    band.merge(lathe([(0.36, 1.0), (0.0, 1.0)], 48, smooth=False))
    for i in range(12):
        a = 2 * math.pi * i / 12
        def rib():
            p = Piece()
            pts = [(r + 0.05, y) for r, y in prof[:-1]] + [(0.47, 0.95)]
            for k in range(len(pts) - 1):
                (r0, y0), (r1, y1) = pts[k], pts[k + 1]
                w0, w1 = 0.05 * (1 - 0.4 * y0), 0.05 * (1 - 0.4 * y1)
                d = 0.07
                p.quad((-w0, y0, r0 + d), (w0, y0, r0 + d), (w1, y1, r1 + d), (-w1, y1, r1 + d), smooth=True)
                p.quad((w0, y0, r0 + d), (w0, y0, r0 - 0.04), (w1, y1, r1 - 0.04), (w1, y1, r1 + d))
                p.quad((-w0, y0, r0 - 0.04), (-w0, y0, r0 + d), (-w1, y1, r1 + d), (-w1, y1, r1 - 0.04))
            return p
        trim.merge(rib().transform(rot_y(a)))
        def slit():
            p = Piece()
            for (r0, y0), (r1, y1) in ((prof[1], prof[2]), (prof[2], prof[3]), (prof[3], prof[4])):
                w = 0.02
                p.quad((-w, y0 + 0.02, r0 + 0.005), (w, y0 + 0.02, r0 + 0.005), (w, y1 - 0.02, r1 + 0.005), (-w, y1 - 0.02, r1 + 0.005))
            return p
        glass.merge(slit().transform(rot_y(a + math.pi / 12)))
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        beacon.merge(box(-0.02, 0.02, 0.975, 1.0, -0.02, 0.02).transform(move(0.41 * math.sin(a), 0, 0.41 * math.cos(a))))
    return dict(wall=wall, trim=trim, band=band, glass=glass, beacon=beacon)


def crown_cluster():
    """Three glazed pods thrown off a core at three heights and bearings, their soffits lit, the top one centred."""
    wall, trim, light, roof, beacon, glass = Piece(), Piece(), Piece(), Piece(), Piece(), Piece()
    wall.merge(box(-0.42, 0.42, 0.0, 0.96, -0.42, 0.42, sides=(True, True, False, False, True, True)))
    pods = [(0.55, 0.0, 0.5, 0.02, 0.3), (-0.5, -0.35, 0.42, 0.3, 0.6), (0.0, 0.0, 0.62, 0.62, 0.96)]
    for (cx, cz, h, y0, y1) in pods:
        trim.merge(box(cx - h, cx + h, y0, y0 + 0.05, cz - h, cz + h))
        light.merge(box(cx - h + 0.05, cx + h - 0.05, y0 - 0.004, y0, cz - h + 0.05, cz + h - 0.05, sides=(False, False, False, True, False, False)))
        glass.merge(box(cx - h + 0.02, cx + h - 0.02, y0 + 0.05, y1 - 0.06, cz - h + 0.02, cz + h - 0.02, sides=(True, True, False, False, True, True)))
        trim.merge(box(cx - h, cx + h, y1 - 0.06, y1, cz - h, cz + h))
        # Vertical carbon frames at the pod corners and mid-faces.
        for u in (-1, 0, 1):
            for s in range(4):
                p = box(u * (h - 0.02) - 0.015, u * (h - 0.02) + 0.015, y0 + 0.05, y1 - 0.06, h - 0.01, h + 0.02).transform(rot_y(s * math.pi / 2)).transform(move(cx, 0, cz))
                trim.merge(p)
    # The canopy over the top pod.
    roof.merge(box(-0.78, 0.78, 0.96, 1.0, -0.78, 0.78))
    for sx in (-1, 1):
        for sz in (-1, 1):
            beacon.merge(box(sx * 0.74 - 0.02, sx * 0.74 + 0.02, 0.975, 1.0, sz * 0.74 - 0.02, sz * 0.74 + 0.02))
    return dict(wall=wall, trim=trim, light=light, roof=roof, beacon=beacon, glass=glass)


# ---------------------------------------------------------------- family modules (unit boxes)


def deco_fin():
    """A deco fin: a stepped profile with a fluted face and a chevron head."""
    p = Piece()
    p.merge(box(-0.5, 0.5, -0.5, 0.42, -0.5, 0.1))
    p.merge(box(-0.3, 0.3, -0.5, 0.42, 0.1, 0.5))
    # Flutes: two grooves cut as darker narrow faces.
    for u in (-0.12, 0.12):
        p.merge(box(u - 0.05, u + 0.05, -0.48, 0.4, 0.49, 0.5, tone=0.7, sides=(False, False, False, False, True, False)))
    # Chevron head.
    p.quad((-0.5, 0.42, 0.5), (0.5, 0.42, 0.5), (0.0, 0.5, 0.5), (0.0, 0.5, 0.5))
    p.merge(box(-0.5, 0.5, 0.42, 0.46, -0.5, 0.5))
    return p


def org_rib():
    """An exoskeleton rib: a tapered blade with knuckles at its thirds."""
    p = Piece()
    p.merge(frustum(0.42, 0.42, -0.5, 0.5, n=6, top=True, bottom=True).transform(scale(1.0, 1.0, 1.0)))
    for y in (-0.17, 0.17):
        p.merge(frustum(0.5, 0.5, y - 0.04, y + 0.04, n=6, top=True, bottom=True))
    return p


def arc_pod():
    """A habitation pod: a concrete box with a recessed balcony at its end and a planter on its lip."""
    p = Piece()
    p.merge(box(-0.5, 0.5, -0.5, 0.5, -0.5, 0.28))
    p.merge(box(-0.5, 0.5, 0.36, 0.5, 0.28, 0.5))
    p.merge(box(-0.5, -0.42, -0.5, 0.36, 0.28, 0.5))
    p.merge(box(0.42, 0.5, -0.5, 0.36, 0.28, 0.5))
    p.merge(box(-0.5, 0.5, -0.5, -0.38, 0.28, 0.5))
    # The balustrade upstand across the front.
    p.merge(box(-0.42, 0.42, -0.38, -0.2, 0.44, 0.5, tone=0.85))
    return p


# ---------------------------------------------------------------- ambient roof and massing kit (unit boxes)


def water_tank():
    """Timber staves on a unit cylinder (radius 0.5), five steel hoops proud of them."""
    p = Piece()
    n = 14
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        tone = 0.86 + 0.14 * ((i * 7) % 5) / 4
        r = 0.5
        # Each stave a flat board, a hair inside its neighbours at the seam.
        q = lambda a, y, rr: (rr * math.sin(a), y, rr * math.cos(a))
        p.quad(q(a0, -0.5, r * 0.985), q(a1, -0.5, r * 0.985), q(a1, 0.5, r * 0.985), q(a0, 0.5, r * 0.985), tone)
        p.quad(q(a0 + 0.004, -0.5, r), q(a1 - 0.004, -0.5, r), q(a1 - 0.004, 0.5, r), q(a0 + 0.004, 0.5, r), tone)
    for y in (-0.34, 0.0, 0.34):
        p.merge(lathe([(0.507, y - 0.015), (0.507, y + 0.015)], 14, tone=0.35, smooth=True))
    p.merge(lathe([(0.49, 0.5), (0.0, 0.5)], 14, smooth=False))
    return p


def tank_cap():
    """A conical roof with a short overhang and a finial, in a unit box."""
    p = Piece()
    p.merge(lathe([(0.5, -0.5), (0.5, -0.42), (0.06, 0.3), (0.0, 0.3)], 14, smooth=False))
    p.merge(lathe([(0.04, 0.3), (0.06, 0.38), (0.0, 0.5)], 6, smooth=False))
    p.merge(lathe([(0.5, -0.5), (0.0, -0.5)], 14, smooth=False))
    return p


def tank_stand():
    """Four steel legs, cross bracing on every side and a timber platform under the tank."""
    p = Piece()
    L = 0.42
    for sx in (-1, 1):
        for sz in (-1, 1):
            p.merge(box(sx * L - 0.04, sx * L + 0.04, -0.5, 0.42, sz * L - 0.04, sz * L + 0.04))
    for s in range(4):
        def brace():
            b = Piece()
            w = 0.018
            for (x0, y0, x1, y1) in ((-L, -0.45, L, 0.3), (L, -0.45, -L, 0.3)):
                b.quad((x0, y0 - w, L), (x1, y1 - w, L), (x1, y1 + w, L), (x0, y0 + w, L))
                b.quad((x1, y1 - w, L - 0.01), (x0, y0 - w, L - 0.01), (x0, y0 + w, L - 0.01), (x1, y1 + w, L - 0.01))
            return b
        p.merge(brace().transform(rot_y(s * math.pi / 2)))
    p.merge(box(-0.5, 0.5, 0.42, 0.5, -0.5, 0.5, tone=0.8))
    return p


def bulkhead():
    """A stair bulkhead: brick walls, a projecting coping, a steel door in a recess and a louvred vent."""
    p = Piece()
    p.merge(box(-0.46, 0.46, -0.5, 0.36, -0.46, 0.46))
    p.merge(box(-0.5, 0.5, 0.36, 0.44, -0.5, 0.5, tone=0.92))
    p.merge(box(-0.47, 0.47, 0.44, 0.5, -0.47, 0.47, tone=0.6))
    # The door, set back in its frame on the +z face.
    p.merge(box(-0.2, 0.2, -0.5, 0.18, 0.44, 0.465, tone=0.42))
    # A vent on the +x face: a grille of slats.
    for k in range(5):
        y = -0.05 + k * 0.05
        p.merge(box(0.46, 0.475, y, y + 0.025, -0.18, 0.18, tone=0.5))
    return p


def penthouse():
    """A mechanical penthouse: a plinth, a louvred band all round, a coping and a roof fan."""
    p = Piece()
    p.merge(box(-0.48, 0.48, -0.5, -0.3, -0.48, 0.48, tone=0.9))
    p.merge(box(-0.45, 0.45, -0.3, 0.38, -0.45, 0.45, tone=0.45))
    # Louvre blades on all four faces, angled down: each a thin sloped strip.
    for s in range(4):
        def blades():
            b = Piece()
            for k in range(6):
                y = -0.28 + k * 0.11
                b.quad((-0.46, y, 0.49), (0.46, y, 0.49), (0.46, y + 0.09, 0.455), (-0.46, y + 0.09, 0.455))
            return b
        p.merge(blades().transform(rot_y(s * math.pi / 2)))
    p.merge(box(-0.5, 0.5, 0.38, 0.44, -0.5, 0.5, tone=0.95))
    p.merge(box(-0.46, 0.46, 0.44, 0.46, -0.46, 0.46, tone=0.6))
    p.merge(lathe([(0.16, 0.46), (0.16, 0.5), (0.0, 0.5)], 6, tone=0.5, smooth=False).transform(move(0.18, 0, -0.12)))
    return p


def screen_panel():
    """A plant screen: vertical fins on rails, with light between them."""
    p = Piece()
    n = 12
    for k in range(n):
        u = -0.5 + (k + 0.5) / n
        p.merge(box(u - 0.018, u + 0.018, -0.5, 0.5, -0.5, 0.5))
    p.merge(box(-0.5, 0.5, -0.5, -0.44, -0.3, 0.3, tone=0.7))
    p.merge(box(-0.5, 0.5, 0.44, 0.5, -0.3, 0.3, tone=0.7))
    return p


def rooftop_unit():
    """A packaged rooftop unit: a cabinet with a side grille and two fans on top."""
    p = Piece()
    p.merge(box(-0.5, 0.5, -0.5, 0.3, -0.5, 0.5, sides=(True, True, True, False, True, True)))
    # The grille as one dark recessed panel, two fan shrouds on top.
    p.merge(box(0.5, 0.505, -0.4, 0.2, -0.4, 0.4, tone=0.5, sides=(True, False, False, False, False, False)))
    for z in (-0.24, 0.24):
        p.merge(lathe([(0.21, 0.3), (0.21, 0.46), (0.0, 0.46)], 6, tone=0.45, smooth=False).transform(move(0.0, 0.0, z)))
    return p


def car():
    """A saloon car seen from above at dusk: body, a glasshouse and wheels, in a unit box (x width, z length)."""
    p = Piece()
    # Body: lower box with sloped bonnet and boot.
    prof = [(-0.5, -0.32), (-0.47, -0.05), (-0.36, 0.05), (0.36, 0.05), (0.47, -0.02), (0.5, -0.32)]
    body = Piece()
    for k in range(len(prof) - 1):
        (z0, y0), (z1, y1) = prof[k], prof[k + 1]
        body.quad((0.5, y0, z0), (-0.5, y0, z0), (-0.5, y1, z1), (0.5, y1, z1))
    for x, sgn in ((0.5, 1), (-0.5, -1)):
        idx = [body.vert((x, y, z)) for z, y in prof]
        body.face(idx if sgn < 0 else list(reversed(idx)))
    p.merge(body)
    # Glasshouse, darker (the shader reads tone as glass).
    g = [(-0.26, 0.05), (-0.14, 0.4), (0.12, 0.4), (0.3, 0.05)]
    for k in range(len(g) - 1):
        (z0, y0), (z1, y1) = g[k], g[k + 1]
        p.quad((0.42, y0, z0), (-0.42, y0, z0), (-0.38, y1, z1), (0.38, y1, z1), tone=0.25)
    for x, sgn in ((0.42, 1), (-0.42, -1)):
        pts = [(x - sgn * (0.04 if y > 0.1 else 0), y, z) for z, y in g]
        idx = [p.vert(q, 0.25) for q in pts]
        p.face(idx if sgn < 0 else list(reversed(idx)))
    for zc in (-0.3, 0.3):
        for x in (-0.5, 0.5):
            p.merge(box(x - 0.04, x + 0.04, -0.5, -0.22, zc - 0.1, zc + 0.1, tone=0.15))
    return p


def bay():
    """One storey of a three-sided oriel bay, a unit box: angled cheeks, a flat front, a sill course at its foot."""
    p = Piece()
    back, front, fw = -0.5, 0.5, 0.3
    pts = [(-0.5, back), (-fw, front), (fw, front), (0.5, back)]
    for k in range(3):
        (x0, z0), (x1, z1) = pts[k], pts[k + 1]
        p.quad((x0, -0.5, z0), (x1, -0.5, z1), (x1, 0.5, z1), (x0, 0.5, z0))
        # The sill course, a little proud, its top catching the light.
        nx, nz = (z1 - z0), -(x1 - x0)
        ln = math.hypot(nx, nz)
        nx, nz = nx / ln * 0.06, nz / ln * 0.06
        p.quad((x0 + nx, -0.5, z0 + nz), (x1 + nx, -0.5, z1 + nz), (x1 + nx, -0.4, z1 + nz), (x0 + nx, -0.4, z0 + nz), tone=0.9)
        p.quad((x0, -0.4, z0), (x1, -0.4, z1), (x1 + nx, -0.4, z1 + nz), (x0 + nx, -0.4, z0 + nz), tone=0.9)
    idx = [p.vert((x, 0.5, z)) for x, z in pts]
    p.face(list(reversed(idx)))
    return p


def bay_glass():
    """One storey of the bay's windows: a pane on each face, set just proud of the bay."""
    p = Piece()
    back, front, fw = -0.5, 0.5, 0.3
    pts = [(-0.5, back), (-fw, front), (fw, front), (0.5, back)]
    for k in range(3):
        (x0, z0), (x1, z1) = pts[k], pts[k + 1]
        nx, nz = (z1 - z0), -(x1 - x0)
        ln = math.hypot(nx, nz)
        nx, nz = nx / ln * 0.01, nz / ln * 0.01
        i = 0.14
        ax, az = x0 + (x1 - x0) * i + nx, z0 + (z1 - z0) * i + nz
        bx, bz = x0 + (x1 - x0) * (1 - i) + nx, z0 + (z1 - z0) * (1 - i) + nz
        p.quad((ax, -0.3, az), (bx, -0.3, bz), (bx, 0.32, bz), (ax, 0.32, az))
    return p


def chamfer_box(c):
    """A unit box with its four vertical edges chamfered `c` (a fraction of the side): a cut corner on a street block."""
    p = Piece()
    h = 0.5
    pts = [(h - c, h), (-h + c, h), (-h, h - c), (-h, -h + c), (-h + c, -h), (h - c, -h), (h, -h + c), (h, h - c)]
    pts = [(x, z) for x, z in pts]
    n = len(pts)
    for k in range(n):
        (x0, z0), (x1, z1) = pts[k], pts[(k + 1) % n]
        p.quad((x1, -0.5, z1), (x0, -0.5, z0), (x0, 0.5, z0), (x1, 0.5, z1))
    top = [p.vert((x, 0.5, z)) for x, z in pts]
    p.face(list(reversed(top)))
    bot = [p.vert((x, -0.5, z)) for x, z in pts]
    p.face(bot)
    return p


def round_box(r, seg=5):
    """A unit box with its four vertical edges rounded to radius `r` (a fraction of the side): a streamline corner."""
    p = Piece()
    h = 0.5
    pts = []
    for cx, cz, a0 in ((h - r, h - r, 0.0), (-h + r, h - r, math.pi / 2), (-h + r, -h + r, math.pi), (h - r, -h + r, 1.5 * math.pi)):
        for k in range(seg + 1):
            a = a0 + (math.pi / 2) * k / seg
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    n = len(pts)
    for k in range(n):
        (x0, z0), (x1, z1) = pts[k], pts[(k + 1) % n]
        p.quad((x1, -0.5, z1), (x0, -0.5, z0), (x0, 0.5, z0), (x1, 0.5, z1), smooth=True)
    top = [p.vert((x, 0.5, z)) for x, z in pts]
    p.face(list(reversed(top)))
    bot = [p.vert((x, -0.5, z)) for x, z in pts]
    p.face(bot)
    return p


# ---------------------------------------------------------------- write

PIECES = {}


def add(name, piece, colours=False):
    PIECES[name] = (piece, colours)


def build():
    add('course_a.hi', course('a', [0.02], True, 11, True), True)
    add('course_a.lo', course('a', [0.02], True, 11, False), True)
    add('course_b.hi', course('b', [-0.25, 0.27], False, 23, True), True)
    add('course_b.lo', course('b', [-0.25, 0.27], False, 23, False), True)
    add('pier_block.hi', course('p', [], True, 37, True, cx=0.04), True)
    add('pier_block.lo', course('p', [], True, 37, False), True)
    add('band_course.hi', band_course(True), True)
    add('band_course.lo', band_course(False), True)
    for fam, fn in (('deco', crown_deco), ('ziggurat', crown_ziggurat), ('needle', crown_needle), ('arcology', crown_arcology), ('organic', crown_organic), ('cluster', crown_cluster)):
        for slot, piece in fn().items():
            if piece.f:
                add(f'crown_{fam}.{slot}', piece)
    add('deco_fin', deco_fin(), True)
    add('org_rib', org_rib())
    add('arc_pod', arc_pod(), True)
    add('water_tank', water_tank(), True)
    add('tank_cap', tank_cap())
    add('tank_stand', tank_stand(), True)
    add('bulkhead', bulkhead(), True)
    add('penthouse', penthouse(), True)
    add('screen_panel', screen_panel(), True)
    add('rooftop_unit', rooftop_unit(), True)
    add('car', car(), True)
    add('bay', bay(), True)
    add('bay_glass', bay_glass())
    add('chamfer_box', chamfer_box(0.12))
    add('round_box', round_box(0.16))


def to_blender(name, piece, colours):
    mesh = bpy.data.meshes.new(name)
    verts = [(x, -z, y) for x, y, z in piece.v]
    mesh.from_pydata(verts, [], piece.f)
    mesh.update()
    for poly, sm in zip(mesh.polygons, piece.smooth):
        poly.use_smooth = sm
    # Merge coincident vertices of smooth faces only, so curved parts shade smooth and flat parts stay flat.
    if colours:
        attr = mesh.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        for i, c in enumerate(piece.col):
            attr.data[i].color = (c, c, c, 1.0)
        mesh.color_attributes.active_color = attr
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def main():
    out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'kits.glb'
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    build()
    for name, (piece, colours) in PIECES.items():
        to_blender(name, piece, colours)
    # Merge by distance on smooth pieces so their normals average; flat faces keep their own normals.
    for o in bpy.context.scene.objects:
        if any(p.use_smooth for p in o.data.polygons):
            import bmesh
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
            bm.to_mesh(o.data)
            bm.free()
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_materials='NONE',
        export_normals=True,
        export_texcoords=False,
        export_vertex_color='ACTIVE',
        export_all_vertex_colors=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.scene.objects)
    print(f'kits: {len(PIECES)} pieces, {tris} triangles -> {out}')


main()
