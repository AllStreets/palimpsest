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


# ---------------------------------------------------------------- vehicles (Task 31)
#
# The elevated train's cab car and the persona cab, modelled as subdivision surfaces: a coarse cage of cross
# sections along the car (x forward, y up from the rail head or the road, z to the side, the vehicle's own frame in
# vehicles.ts), smoothed by two levels of Catmull-Clark, so the noses, roofs and flanks are true curves. Each face
# carries a material code in its corner colour's red channel, (code + 0.5) / 32, which subdivision keeps per face;
# vehicles.ts splits the triangles by code into its body, trim, glazing and lamp parts and paints them. The running
# gear, coupler, lamps and fittings are a second mesh, placed on the smoothed surface by casting rays at it.

VEH = {
    'steel': 1, 'steel_roof': 2, 'mask': 3, 'teal': 4, 'under': 5, 'glass': 6, 'dark': 7, 'iron': 8, 'wheel': 9,
    'head': 10, 'tail': 11, 'board': 12, 'cream': 13, 'graphite': 14, 'roof': 15, 'chrome': 16, 'white': 17,
    'red': 18, 'amber': 19, 'tyre': 20, 'rubber': 21, 'nose': 22,
}


class Coded(Piece):
    """A Piece whose faces each carry a material code."""

    def __init__(self):
        super().__init__()
        self.code = []

    def face(self, idx, smooth=True, code=0):
        super().face(idx, smooth)
        self.code.append(code)

    def quad(self, a, b, c, d, tone=1.0, smooth=True, code=0):
        i = [self.vert(p) for p in (a, b, c, d)]
        self.face(i, smooth, code)

    def take(self, other, code):
        """Another (uncoded) piece, every face in one code."""
        o = len(self.v)
        self.v += other.v
        self.col += other.col
        for f, sm in zip(other.f, other.smooth):
            self.f.append(tuple(i + o for i in f))
            self.smooth.append(sm)
            self.code.append(code)
        return self


def sections_cage(loops, code_of):
    """Quads between consecutive section loops (each the same count, running round the section), both ends capped.
    Faces are turned to face away from the axis; code_of(centre, i, j) names each face's material."""
    p = Coded()
    n = len(loops[0])
    def centre(pts):
        return tuple(sum(q[k] for q in pts) / len(pts) for k in range(3))
    for i in range(len(loops) - 1):
        a, b = loops[i], loops[i + 1]
        for j in range(n):
            k = (j + 1) % n
            quad = [a[j], b[j], b[k], a[k]]
            c = centre(quad)
            # Outward: away from the section's own middle line (y and z about the loop's centroid).
            mid = centre(a + b)
            u = [quad[1][t] - quad[0][t] for t in range(3)]
            w = [quad[3][t] - quad[0][t] for t in range(3)]
            nrm = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            out = (0.0, c[1] - mid[1], c[2] - mid[2])
            if nrm[1] * out[1] + nrm[2] * out[2] < 0:
                quad = list(reversed(quad))
            p.quad(*quad, code=code_of(c, i, j))
    # Each end closed as strips across the car, right point to left point at the same height (all quads but the
    # top and bottom triangles), so the subdivided end is smooth and every band of paint across it runs straight.
    m = (n - 2) // 2
    for loop, sgn in ((loops[0], -1), (loops[-1], 1)):
        right = loop[1:m + 1]
        left = list(reversed(loop[m + 2:]))
        rows = [[loop[0]]] + [[r, l] for r, l in zip(right, left)] + [[loop[m + 1]]]
        for a, b in zip(rows, rows[1:]):
            poly = a + list(reversed(b)) if len(a) == 2 and len(b) == 2 else (a + list(reversed(b)) if len(b) == 2 else a + b)
            if len(a) == 1:
                poly = [a[0], b[0], b[1]]
            elif len(b) == 1:
                poly = [a[0], b[0], a[1]]
            else:
                poly = [a[0], b[0], b[1], a[1]]
            c = centre(poly)
            u = [poly[1][t] - poly[0][t] for t in range(3)]
            w = [poly[2][t] - poly[0][t] for t in range(3)]
            nx = u[1] * w[2] - u[2] * w[1]
            if nx * sgn < 0:
                poly = list(reversed(poly))
            p.face([p.vert(q) for q in poly], True, code_of(c, -1 if sgn < 0 else len(loops), 0))
    return p


def section(half, x_of, scale=1.0):
    """A closed section loop from the right half's (z, y) points (bottom centre to top centre, exclusive), mirrored."""
    pts = [(0.0, half[0][1])] + half[1:] + [(0.0, half[-1][1] + 0.01)]
    right = [(x_of(y), y, z * scale) for z, y in pts]
    left = [(x_of(y), y, -z * scale) for z, y in reversed(pts[1:-1])]
    return right + left


# The train's section, as vehicles.ts's RAIL_RINGS: underframe at 0.85, sill 1.78, head 2.85, roof 3.75.
RAIL_HALF = [(0.0, 0.85), (1.22, 0.85), (1.36, 0.92), (1.40, 1.02), (1.42, 1.45), (1.42, 1.78), (1.41, 2.3), (1.40, 2.85),
             (1.36, 3.3), (1.2, 3.55), (0.86, 3.68), (0.4, 3.75)]
RAIL_DOORS = (3.4, -3.4)


def rail_end_body():
    """The cab car's shell: flat at its gangway end (-x), a raked, rounded nose (+x)."""
    def x_at(x0, rake, low=0.0):
        def f(y):
            t = max(0.0, min(1.0, (y - 1.78) / (3.76 - 1.78)))
            b = max(0.0, min(1.0, (1.1 - y) / 0.25))
            return x0 - rake * t * t ** 0.0 - low * b
        return f
    stations = [(-7.6, 1.0, 0.0, 0.0), (-7.5, 1.0, 0.0, 0.0), (-6.0, 1.0, 0.0, 0.0)]
    for d in sorted(RAIL_DOORS):
        stations += [(d - 0.7, 1.0, 0.0, 0.0), (d + 0.7, 1.0, 0.0, 0.0)]
    stations += [(5.6, 1.0, 0.0, 0.0), (6.3, 1.0, 0.0, 0.0), (6.85, 0.97, 0.2, 0.02), (7.25, 0.88, 0.48, 0.06),
                 (7.52, 0.7, 0.72, 0.1), (7.64, 0.42, 0.86, 0.14)]
    loops = [section(RAIL_HALF, x_at(x, rake, low), sc) for x, sc, rake, low in stations]
    def code(c, i, j):
        x, y, z = c
        if i < 0:
            return VEH['steel']
        if y < 1.0:
            return VEH['under']
        nose = x > 6.2
        if nose:
            if 1.78 < y < 2.85 and abs(z) < 1.05:
                return VEH['glass']
            if 1.78 < y < 3.25:
                return VEH['mask']
            if y >= 3.25:
                return VEH['mask']
            return VEH['nose']
        if 1.78 < y < 2.85:
            return VEH['glass']
        door = any(abs(x - d) < 0.69 for d in RAIL_DOORS)
        if door and abs(z) > 1.0:
            return VEH['teal']
        if 1.45 < y < 1.6:
            return VEH['teal']
        return VEH['steel_roof'] if y > 3.3 else VEH['steel']
    return sections_cage(loops, code)


CAB_HALF = [(0.0, 0.18), (0.7, 0.18), (0.86, 0.24), (0.9, 0.34), (0.905, 0.6), (0.9, 0.86), (0.885, 0.92), (0.855, 1.05),
            (0.78, 1.34), (0.66, 1.47), (0.4, 1.54)]


def cab_body():
    """The persona cab: a compact rounded body, a glass canopy raked fore and aft, a dark roof panel."""
    front = [(0.6, 1.98), (0.84, 1.93), (0.9, 1.86), (1.05, 1.58), (1.34, 0.98), (1.45, 0.72), (1.56, 0.5)]
    rear = [(0.6, 1.96), (0.84, 1.94), (0.9, 1.92), (1.05, 1.8), (1.34, 1.4), (1.45, 1.18), (1.56, 0.95)]
    def reach(table, y):
        if y <= table[0][0]:
            return table[0][1]
        for (y0, a), (y1, b) in zip(table, table[1:]):
            if y <= y1:
                t = (y - y0) / (y1 - y0)
                return a + (b - a) * t
        return table[-1][1]
    def x_of(x):
        return lambda y: x * (reach(front if x > 0 else rear, y) / 1.98)
    stations = [(-1.97, 0.5), (-1.9, 0.8), (-1.73, 0.95), (-1.4, 1.0), (-0.83, 1.0), (-0.75, 1.0), (-0.71, 1.0), (0.0, 1.0),
                (0.6, 1.0), (0.64, 1.0), (0.83, 1.0), (1.4, 1.0), (1.73, 0.95), (1.9, 0.8), (1.97, 0.5)]
    loops = [section(CAB_HALF, x_of(x), sc) for x, sc in stations]
    def code(c, i, j):
        x, y, z = c
        if y > 1.43:
            return VEH['roof']
        if y > 0.92:
            return VEH['glass']
        if y < 0.33:
            return VEH['graphite']
        side = abs(z) > 0.6
        if side and y < 0.66 and any(abs(abs(x) - 1.28) < 0.44 for _ in (0,)) and 0.83 < abs(x) < 1.73:
            return VEH['graphite']
        if side and (0.59 < x < 0.65 or -0.76 < x < -0.70):
            return VEH['rubber']
        return VEH['cream']
    return sections_cage(loops, code)


def wheel(r, w, flange=0.0, seg=16):
    """A wheel on an axle along z: lathed about y, then turned onto z."""
    prof = [(0.0, -w / 2), (r * 0.6, -w / 2), (r, -w / 2 + 0.02), (r + flange, -w / 2 + 0.03), (r + flange, -w / 2 + 0.06), (r, -w / 2 + 0.08),
            (r, w / 2 - 0.02), (r * 0.62, w / 2), (r * 0.25, w / 2 + 0.03), (0.0, w / 2 + 0.03)]
    p = lathe(prof, seg)
    return p.transform(lambda q: (q[0], -q[2], q[1]))


def rod_x(r, x0, x1, seg=12):
    p = lathe([(0.0, x0), (r, x0), (r, x1), (0.0, x1)], seg)
    return p.transform(lambda q: (q[1], -q[0], q[2]))


def placed(piece, fn):
    return piece.transform(fn)


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


def coded_object(name, piece, subsurf):
    """A coded piece into Blender: smooth, merged, its codes in a corner colour, Catmull-Clark subdivided."""
    import bmesh
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([(x, -z, y) for x, y, z in piece.v], [], piece.f)
    mesh.update()
    for poly, sm in zip(mesh.polygons, piece.smooth):
        poly.use_smooth = sm
    attr = mesh.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    for poly, code in zip(mesh.polygons, piece.code):
        for li in poly.loop_indices:
            attr.data[li].color = ((code + 0.5) / 32.0, 0.0, 0.0, 1.0)
    mesh.color_attributes.active_color = attr
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if subsurf:
        m = obj.modifiers.new('subsurf', 'SUBSURF')
        m.levels = subsurf
        m.render_levels = subsurf
    return obj


def surface_x(obj, y, z, sgn=1.0):
    """Where the smoothed body's surface stands along x at height y and side z, from its nose (sgn 1) or tail (-1)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    ok, loc, nrm, _ = ev.ray_cast((sgn * 20.0, -z, y), (-sgn, 0.0, 0.0))
    return (loc[0], (nrm[0], nrm[2], -nrm[1])) if ok else (None, None)


def surface_z(obj, x, y):
    """Where the body's flank stands across z at x and height y (its +z side)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    ok, loc, _n, _ = ev.ray_cast((x, -5.0, y), (0.0, 1.0, 0.0))
    return -loc[1] if ok else None


def facing(piece, nx, nz):
    """Turns a piece built facing +x to face the plan direction (nx, nz)."""
    a = math.atan2(nz, nx)
    c, s = math.cos(a), math.sin(a)
    return piece.transform(lambda q: (q[0] * c - q[2] * s, q[1], q[0] * s + q[2] * c))


def rail_end_gear(body):
    """The cab car's running gear, coupler, lamps, destination board, wiper and fittings, on its smoothed shell."""
    for bx in (-5.3, 5.3):
        # Bogie: side frames, spring planks, axle boxes and springs, flanged wheelsets, brake units and a bolster.
        frame = Coded()
        for sz in (-1, 1):
            frame.take(placed(round_box(0.2, 3), lambda q: (q[0] * 2.5 + bx, q[1] * 0.26 + 0.52, q[2] * 0.14 + sz * 1.02)), VEH['iron'])
            frame.take(placed(round_box(0.2, 3), lambda q: (q[0] * 0.9 + bx, q[1] * 0.18 + 0.36, q[2] * 0.12 + sz * 1.02)), VEH['iron'])
            for ax in (-1.1, 1.1):
                frame.take(placed(round_box(0.25, 3), lambda q: (q[0] * 0.34 + bx + ax, q[1] * 0.26 + 0.42, q[2] * 0.16 + sz * 1.1)), VEH['dark'])
                frame.take(placed(lathe([(0.0, 0.0), (0.07, 0.0), (0.07, 0.22), (0.0, 0.22)], 10), lambda q: (q[0] + bx + ax, q[1] + 0.55, q[2] + sz * 1.1)), VEH['chrome'])
                frame.take(placed(wheel(0.42, 0.14, 0.03), lambda q: (q[0] + bx + ax, q[1] + 0.42, q[2] + sz * 0.72)), VEH['wheel'])
            frame.take(placed(round_box(0.2, 3), lambda q: (q[0] * 0.5 + bx, q[1] * 0.3 + 0.48, q[2] * 0.3 + sz * 0.8)), VEH['dark'])
        frame.take(placed(round_box(0.2, 3), lambda q: (q[0] * 0.6 + bx, q[1] * 0.2 + 0.7, q[2] * 2.0)), VEH['iron'])
        for ax in (-1.1, 1.1):
            frame.take(rod_x(0.06, -0.9, 0.9).transform(lambda q: (q[2] + bx + ax, q[1] + 0.42, -q[0])), VEH['iron'])
        GEAR.append(frame)
    # Under-floor equipment: cases with ribbed fronts between the bogies.
    cases = Coded()
    for x0, x1 in ((-3.6, -1.0), (0.4, 3.4)):
        cases.take(placed(round_box(0.1, 2), lambda q: (q[0] * (x1 - x0) + (x0 + x1) / 2, q[1] * 0.42 + 0.66, q[2] * 2.2)), VEH['under'])
        x = x0 + 0.15
        while x < x1 - 0.1:
            for sz in (-1, 1):
                cases.take(box(x, x + 0.03, 0.48, 0.84, sz * 1.1 - 0.012, sz * 1.1 + 0.012), VEH['dark'])
            x += 0.3
    GEAR.append(cases)
    # Coupler: draft gear pocket, shank, a rounded knuckle head with its guide horn, and the anticlimber over it.
    nose_x, nrm = surface_x(body, 1.0, 0.0)
    nx = nose_x if nose_x is not None else 7.6
    cp = Coded()
    cp.take(rod_x(0.075, nx - 0.3, nx + 0.42, 14).transform(lambda q: (q[0], q[1] + 0.98, q[2])), VEH['iron'])
    cp.take(placed(round_box(0.3, 4), lambda q: (q[0] * 0.16 + nx + 0.46, q[1] * 0.3 + 0.98, q[2] * 0.36)), VEH['iron'])
    cp.take(placed(round_box(0.3, 3), lambda q: (q[0] * 0.18 + nx + 0.5, q[1] * 0.1 + 0.8, q[2] * 0.12 + 0.14)), VEH['iron'])
    cp.take(placed(round_box(0.15, 3), lambda q: (q[0] * 0.3 + nx - 0.02, q[1] * 0.18 + 1.2, q[2] * 1.7)), VEH['dark'])
    # Obstacle deflector: a shallow vee plough under the nose.
    for sz in (-1, 1):
        a = (nx + 0.05, 0.42, 0.0)
        b = (nx - 0.25, 0.42, sz * 1.25)
        cp.quad(a, b, (b[0], 0.86, b[2]), (a[0], 0.86, a[2]), code=VEH['under']) if sz > 0 else cp.quad(b, a, (a[0], 0.86, a[2]), (b[0], 0.86, b[2]), code=VEH['under'])
    GEAR.append(cp)
    # Lamps on the nose's surface: twin head and tail clusters, set in dark bezels.
    lamps = Coded()
    for sz in (-1, 1):
        for zc, kind, w in ((0.86, 'head', 0.26), (1.16, 'tail', 0.11)):
            x, n = surface_x(body, 1.3, sz * zc)
            if x is None:
                continue
            lens = placed(round_box(0.35, 3), lambda q: (q[0] * 0.04, q[1] * 0.1 + 1.3, q[2] * w))
            lens = facing(lens, n[0], n[2]).transform(lambda q, x=x, zc=zc, sz=sz: (q[0] + x + 0.01, q[1], q[2] + sz * zc))
            lamps.take(lens, VEH[kind])
            bez = placed(round_box(0.35, 3), lambda q: (q[0] * 0.03, q[1] * 0.17 + 1.3, q[2] * (w + 0.08)))
            bez = facing(bez, n[0], n[2]).transform(lambda q, x=x, zc=zc, sz=sz: (q[0] + x, q[1], q[2] + sz * zc))
            lamps.take(bez, VEH['dark'])
    # The destination board over the windscreen: an LED panel under a glass cover, in a black surround.
    x, n = surface_x(body, 3.05, 0.0)
    if x is not None:
        lamps.take(facing(box(-0.02, 0.0, 2.95, 3.15, -0.62, 0.62), n[0], n[2]).transform(lambda q: (q[0] + x + 0.012, q[1], q[2])), VEH['board'])
        lamps.take(facing(box(-0.02, 0.0, 2.9, 3.2, -0.7, 0.7), n[0], n[2]).transform(lambda q: (q[0] + x + 0.004, q[1], q[2])), VEH['dark'])
    # A wiper parked on the windscreen, and the cab door's handle and grab rail on the flank behind the nose.
    x0, n0 = surface_x(body, 1.9, -0.1)
    x1, n1 = surface_x(body, 2.45, 0.42)
    if x0 is not None and x1 is not None:
        lamps.take(rod_x(0.012, 0.0, 1.0, 6).transform(lambda q: (x0 + 0.03 + (x1 - x0) * q[0], 1.9 + 0.55 * q[0] + q[1], -0.1 + 0.52 * q[0] + q[2])), VEH['dark'])
    for sz in (-1, 1):
        zf = surface_z(body, 5.9, 2.0) or 1.42
        lamps.take(lathe([(0.0, 1.3), (0.018, 1.3), (0.018, 2.5), (0.0, 2.5)], 8).transform(lambda q, sz=sz, zf=zf: (q[0] + 5.85, q[1], sz * (zf + 0.05) + q[2])), VEH['chrome'])
    # Gangway bellows at the coupled end, and air-conditioning on the roof.
    lamps.take(placed(round_box(0.2, 3), lambda q: (q[0] * 0.4 - 7.8, q[1] * 2.3 + 2.2, q[2] * 1.7)), VEH['dark'])
    for rx in (-4.2, 2.6):
        lamps.take(placed(round_box(0.3, 4), lambda q: (q[0] * 2.6 + rx, q[1] * 0.25 + 3.86, q[2] * 1.5)), VEH['steel_roof'])
    GEAR.append(lamps)


def cab_gear(body):
    """The cab's wheels, light bars, roof light, sensor, door handles and camera pods, on its smoothed body."""
    g = Coded()
    for wx in (-1.28, 1.28):
        for sz in (-1, 1):
            tyre = lathe([(0.0, -0.12), (0.24, -0.12), (0.31, -0.11), (0.335, -0.07), (0.335, 0.07), (0.31, 0.11), (0.24, 0.12), (0.0, 0.12)], 24)
            g.take(tyre.transform(lambda q, wx=wx, sz=sz: (q[0] + wx, -q[2] + 0.335, q[1] + sz * 0.79)), VEH['tyre'])
            rim = lathe([(0.0, 0.0), (0.235, 0.0), (0.225, 0.02), (0.08, 0.035), (0.0, 0.04)], 24)
            rim.transform(lambda q, wx=wx, sz=sz: (q[0] + wx, -q[2] + 0.335, sz * (0.91 + q[1])))
            if sz < 0:
                rim.f = [tuple(reversed(f)) for f in rim.f]
            g.take(rim, VEH['chrome'])
    for e, kind in ((1, 'white'), (-1, 'red')):
        pts = []
        for k in range(9):
            z = -0.6 + 1.2 * k / 8
            x, n = surface_x(body, 0.74, z, e)
            if x is not None:
                pts.append((x + e * 0.006, z))
        for (xa, za), (xb, zb) in zip(pts, pts[1:]):
            # A slim lens between each pair of points on the surface: a box a few millimetres proud of it.
            cx, cz = (xa + xb) / 2, (za + zb) / 2
            ln = math.hypot(xb - xa, zb - za)
            ang = math.atan2(zb - za, xb - xa)
            seg = box(-ln / 2 - 0.004, ln / 2 + 0.004, 0.72, 0.765, -0.012, 0.012)
            c, sn = math.cos(ang), math.sin(ang)
            g.take(seg.transform(lambda q, cx=cx, cz=cz, c=c, sn=sn: (cx + q[0] * c - q[2] * sn + e * 0.004, q[1], cz + q[0] * sn + q[2] * c)), VEH[kind])
    g.take(placed(round_box(0.3, 4), lambda q: (q[0] * 0.5 + 0.05, q[1] * 0.07 + 1.585, q[2] * 0.2)), VEH['amber'])
    g.take(placed(round_box(0.3, 3), lambda q: (q[0] * 0.56 + 0.05, q[1] * 0.04 + 1.54, q[2] * 0.25)), VEH['graphite'])
    g.take(lathe([(0.0, 1.52), (0.065, 1.52), (0.065, 1.6), (0.05, 1.62), (0.0, 1.625)], 16).transform(lambda q: (q[0] + 0.45, q[1], q[2])), VEH['rubber'])
    for sz in (-1, 1):
        zf = surface_z(body, 0.3, 0.7) or 0.905
        g.take(placed(round_box(0.4, 3), lambda q, sz=sz, zf=zf: (q[0] * 0.18 + 0.35, q[1] * 0.035 + 0.74, sz * (zf + 0.012) + q[2] * 0.02)), VEH['chrome'])
    GEAR.append(g)


GEAR = []


def build_vehicles():
    """The train's cab car and the cab: each a subdivided shell and a mesh of its fittings."""
    rail = coded_object('veh_railEnd', rail_end_body(), 2)
    cab = coded_object('veh_cab', cab_body(), 1)
    GEAR.clear()
    rail_end_gear(rail)
    gear = Coded()
    for part in GEAR:
        o = len(gear.v)
        gear.v += part.v
        gear.col += part.col
        gear.f += [tuple(i + o for i in f) for f in part.f]
        gear.smooth += part.smooth
        gear.code += part.code
    coded_object('veh_railEnd_gear', gear, 0)
    GEAR.clear()
    cab_gear(cab)
    coded_object('veh_cab_gear', GEAR[0], 0)


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
    build_vehicles()
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
