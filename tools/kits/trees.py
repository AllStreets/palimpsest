"""
Palimpsest's trees, modelled in Blender from code: three species at two
levels each, written to app/public/kits/trees.glb (its own file, capped at
600 KB; kits.glb has no room left under its own cap).

Run headless as part of the kit build (tools/kits/kits.py calls it after
kits.glb), or alone:

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python tools/kits/trees.py -- app/public/kits/trees.glb

The species:

- `plane`: a London plane, the street tree of the old city. A clear bole to a
  fork at 4.2 m, four limbs spreading wide, a broad rounded crown, open
  enough underneath to see the limbs, its bark in shed plates.
- `linden`: a common lime, the avenue and quad tree. A central leader to near
  the top, ascending laterals in a spiral, a dense egg-shaped crown.
- `hornbeam`: a columnar hornbeam (Carpinus betulus 'Fastigiata'), for narrow
  streets, roof planters and formal corners. A short stem, many steep limbs,
  a tight flame-shaped crown, smooth grey fluted bark.

Each species is grown the same way: limbs run from the fork toward points
inside the crown's envelope, branches from them toward its shell, twigs to
the shell itself, so every branch tip sits in the leafy outer layer where a
real crown carries its leaves. Leaf cards (quads carrying a cluster of
leaves from the app's leaf atlas, trees.ts) are hung round the twig tips and
over the shell, facing mostly outward; their normals are bent toward the
crown's own round, so a crown shades as one volume of leaves and never as a
pile of flat cards. Bark is a tapered tube per bole, limb and branch; the
twigs place the cards and are lost in their own leaves, so they draw nothing.

Levels, by node name: `<species>.near` (the whole tree, every branch and a
full set of small cards) and `<species>.far` (the bole alone and a fifth as
many cards at twice the size, for past the near radius).

Every vertex carries, besides position and normal:

    COLOR_0   uint8 x4 normalized: rgb a tone (the bark's own colour; a leaf's
              shade, darker inside and under the crown), a unused (255)
    TEXCOORD_0 uint16 x2 normalized: a leaf card's place in the atlas (2 by 2
              cells of leaf clusters); bark: around and along the branch
    _TREE     uint8 x4: kind (0 bark, 1 leaf), sway (0..255: how far the wind
              moves it, 0 at the root), phase (0..255: a branch's own phase,
              so limbs move apart), height (0..255 over the tree's height)

Positions are int16 about the mesh's centre (KHR_mesh_quantization; the
node's translation and scale put them back in metres, as app/src/city/kits.ts
parseGlb reads them), normals int8. Seeded: the same script always writes the
same file.
"""

import json
import math
import random
import struct
import sys

import numpy as np

# ---------------------------------------------------------------- the species

SPECIES = {
    'plane': {
        'seed': 7,
        'height': 16.0,
        'fork': 4.2,
        'trunk': (0.42, 0.3),
        'centre': (0.0, 10.4, 0.0),
        'radii': (6.6, 5.6, 6.6),
        'limbs': 4,
        'leader': False,
        'card': 1.75,
        'cards': 470,
        'far_cards': 52,
        'bark': 'plates',
    },
    'linden': {
        'seed': 19,
        'height': 15.3,
        'fork': 2.8,
        'trunk': (0.34, 0.2),
        'centre': (0.0, 8.7, 0.0),
        'radii': (4.5, 5.8, 4.5),
        'limbs': 9,
        'leader': True,
        'card': 1.45,
        'cards': 480,
        'far_cards': 52,
        'bark': 'fissured',
    },
    'hornbeam': {
        'seed': 31,
        'height': 10.2,
        'fork': 1.5,
        'trunk': (0.26, 0.17),
        'centre': (0.0, 6.8, 0.0),
        'radii': (1.5, 5.2, 1.5),
        'limbs': 8,
        'leader': False,
        'card': 0.95,
        'cards': 420,
        'far_cards': 52,
        'bark': 'smooth',
    },
}


def envelope(sp, d):
    """The crown's radius along unit direction d from its centre: an ellipsoid shaped per species."""
    rx, ry, rz = sp['radii']
    x, y, z = d
    if sp is SPECIES['linden']:
        # An egg: fuller below the middle, drawn to a blunt point at the top.
        k = 1.0 - 0.28 * max(0.0, y) ** 2 + 0.06 * max(0.0, -y)
        rx, rz = rx * k, rz * k
    elif sp is SPECIES['hornbeam']:
        # A flame: widest a third of the way up the crown, closing to a point at the top, rounded at the foot.
        k = 1.0 - 0.45 * max(0.0, y) ** 1.5 + 0.08 * max(0.0, -y)
        rx, rz = rx * k, rz * k
    return 1.0 / math.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2)


def lumpy(sp, d, salt):
    """A slow lobing of the envelope, so the shell bulges and dips like a real crown's clumps."""
    a = math.atan2(d[2], d[0])
    e = math.asin(max(-1.0, min(1.0, d[1])))
    return 1.0 + 0.09 * math.sin(3 * a + salt) * math.cos(2 * e) + 0.06 * math.sin(5 * a - 2 * e + salt * 1.7)


def norm(v):
    n = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) or 1.0
    return (v[0] / n, v[1] / n, v[2] / n)


def add(a, b, k=1.0):
    return (a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k)


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def shell_point(sp, d, f, salt):
    """The point at fraction f of the way from the crown's centre to its (lobed) shell along d."""
    c = sp['centre']
    r = envelope(sp, d) * lumpy(sp, d, salt) * f
    return add(c, d, r)


# ---------------------------------------------------------------- growing the branches


class Branch:
    def __init__(self, path, r0, r1, depth, phase):
        self.path = path  # points along the branch, root first
        self.r0 = r0
        self.r1 = r1
        self.depth = depth
        self.phase = phase


def bent_path(a, b, rng, sag=0.12, n=4):
    """A branch from a to b that bows a little upward and wanders, in n segments."""
    pts = []
    ab = sub(b, a)
    length = math.sqrt(dot(ab, ab))
    side = norm(cross(ab, (rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))))
    for i in range(n + 1):
        t = i / n
        bow = math.sin(math.pi * t) * length
        p = add(a, ab, t)
        p = add(p, (0, 1, 0), bow * sag * 0.6)
        p = add(p, side, bow * sag * 0.25 * math.sin(2 * math.pi * t + 0.5))
        pts.append(p)
    return pts


def grow(name):
    sp = SPECIES[name]
    rng = random.Random(sp['seed'])
    c = sp['centre']
    branches = []
    tips = []
    salt = sp['seed'] * 0.37
    fork = (0.0, sp['fork'], 0.0)
    if sp['leader']:
        # The leader runs up through the crown to near its top, leaning a touch.
        top = shell_point(sp, (0.0, 1.0, 0.0), 0.82, salt)
        trunk = bent_path((0, 0, 0), add(top, (0.25, 0, -0.15)), rng, sag=0.02, n=7)
    else:
        trunk = bent_path((0, 0, 0), fork, rng, sag=0.03, n=3)
    branches.append(Branch(trunk, sp['trunk'][0], sp['trunk'][1] * (0.35 if sp['leader'] else 1.0), 0, 0.0))
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(sp['limbs']):
        az = i * (2 * math.pi / sp['limbs']) + rng.uniform(-0.35, 0.35) if not sp['leader'] else i * golden + rng.uniform(-0.2, 0.2)
        if name == 'plane':
            elev = rng.uniform(0.55, 0.85)  # from the horizontal: wide spreading limbs
            base = add(fork, (0, rng.uniform(-0.2, 0.3), 0))
            reach = 0.62
        elif name == 'linden':
            # Laterals up the leader, ascending, shorter toward the top.
            t = (i + 0.5) / sp['limbs']
            y = sp['fork'] + t * (trunk[-1][1] - sp['fork']) * 0.88
            base = (trunk[0][0] + (trunk[-1][0] - trunk[0][0]) * y / trunk[-1][1], y, trunk[0][2] + (trunk[-1][2] - trunk[0][2]) * y / trunk[-1][1])
            elev = 0.35 + 0.65 * t + rng.uniform(-0.1, 0.1)
            reach = 0.86
        else:
            elev = rng.uniform(1.15, 1.35)  # steep: the column's limbs climb nearly upright
            base = add(fork, (0, rng.uniform(-0.3, 0.6), 0))
            reach = 0.78
        d = norm((math.cos(az) * math.cos(elev), math.sin(elev), math.sin(az) * math.cos(elev)))
        # The limb's end: where its direction meets the crown's inner shell, seen from the crown's centre.
        guess = add(base, d, 4.0)
        dc = norm(sub(guess, c))
        end = shell_point(sp, dc, reach, salt)
        r0 = sp['trunk'][1] * (0.78 if not sp['leader'] else 0.42)
        phase = rng.random()
        limb = Branch(bent_path(base, end, rng, sag=0.1), r0, r0 * 0.45, 1, phase)
        branches.append(limb)
        # Branches off the limb toward the shell, and twigs off each to the shell itself.
        nb = 3 if name == 'plane' else 2
        for j in range(nb):
            t = 0.4 + 0.55 * (j + rng.random() * 0.5) / nb
            k = min(len(limb.path) - 1, int(t * (len(limb.path) - 1)))
            at = limb.path[k]
            out = norm(add(sub(at, c), (rng.uniform(-1, 1), rng.uniform(-0.4, 1.0), rng.uniform(-1, 1)), 2.2))
            bend = shell_point(sp, out, 0.9, salt)
            br = Branch(bent_path(at, bend, rng, sag=0.14, n=3), limb.r1 * 0.75, 0.035, 2, phase + rng.uniform(-0.1, 0.1))
            branches.append(br)
            for _ in range(2 if name != 'hornbeam' else 1):
                k2 = rng.randint(1, len(br.path) - 1)
                at2 = br.path[k2]
                out2 = norm(add(sub(at2, c), (rng.uniform(-1, 1), rng.uniform(-0.5, 1.0), rng.uniform(-1, 1)), 3.0))
                twig_end = shell_point(sp, out2, 0.98, salt)
                tw = Branch(bent_path(at2, twig_end, rng, sag=0.1, n=2), 0.04, 0.015, 3, br.phase + rng.uniform(-0.1, 0.1))
                branches.append(tw)
                tips.append((twig_end, tw.phase))
            tips.append((br.path[-1], br.phase))
        tips.append((limb.path[-1], phase))
    return sp, branches, tips


# ---------------------------------------------------------------- meshing


class Mesh:
    def __init__(self):
        self.P = []
        self.N = []
        self.C = []
        self.UV = []
        self.T = []  # _TREE
        self.I = []

    def vert(self, p, n, col, uv, tree):
        self.P.append(p)
        self.N.append(n)
        self.C.append(col)
        self.UV.append(uv)
        self.T.append(tree)
        return len(self.P) - 1


def bark_tone(kind, p, a, rng_noise):
    """The bark's colour at a point (linear-ish rgb in 0..1)."""
    n1 = rng_noise(p[0] * 1.7 + math.cos(a) * 0.9, p[1] * 1.3, p[2] * 1.7 + math.sin(a) * 0.9)
    n2 = rng_noise(p[0] * 5.1, p[1] * 4.3 + 7, p[2] * 5.1)
    if kind == 'plates':
        # The plane's camouflage: cream, olive and grey-brown plates where the old bark has shed.
        cream = (0.4, 0.38, 0.31)
        olive = (0.29, 0.29, 0.22)
        brown = (0.21, 0.18, 0.15)
        c = cream if n1 > 0.62 else olive if n1 > 0.42 else brown
        return tuple(c[i] * (0.9 + 0.2 * n2) for i in range(3))
    if kind == 'fissured':
        # The lime's grey-brown, darker in its fissures.
        base = (0.2, 0.175, 0.15)
        k = 0.7 + 0.45 * n2 * n1
        return tuple(base[i] * k for i in range(3))
    # The hornbeam's smooth grey, with lighter streaks down its flutes.
    base = (0.28, 0.28, 0.27)
    k = 0.85 + 0.25 * math.sin(a * 5 + n1 * 2) * 0.5 + 0.15 * n2
    return tuple(base[i] * k for i in range(3))


def vnoise(x, y, z):
    def h(a, b, c):
        s = math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
        return s - math.floor(s)
    xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
    f = lambda t: t * t * (3 - 2 * t)
    u, v, w = f(x - xi), f(y - yi), f(z - zi)
    l = lambda a, b, t: a + (b - a) * t
    return l(
        l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
        l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
        w,
    )


def sway_at(sp, p):
    """How far the wind moves a point: nothing at the root, rising through the crown, most at its rim."""
    h = max(0.0, (p[1] - sp['fork'] * 0.6) / (sp['height'] - sp['fork'] * 0.6))
    out = math.sqrt(p[0] ** 2 + p[2] ** 2) / max(sp['radii'][0], 1.0)
    return max(0.0, min(1.0, 0.75 * h ** 1.4 + 0.35 * out ** 1.5))


def tube(m, sp, br, sides, total):
    """A tapered tube along the branch's path, a ring at each point."""
    path = br.path
    n = len(path)
    rings = []
    length = 0.0
    for i in range(n):
        t = i / (n - 1)
        r = br.r0 + (br.r1 - br.r0) * t
        if br.depth == 0 and i == 0:
            r *= 1.35  # the root flare
        d = norm(sub(path[min(i + 1, n - 1)], path[max(i - 1, 0)]))
        side = norm(cross(d, (0.0, 0.0, 1.0) if abs(d[2]) < 0.9 else (1.0, 0.0, 0.0)))
        up = cross(side, d)
        if i > 0:
            length += math.sqrt(dot(sub(path[i], path[i - 1]), sub(path[i], path[i - 1])))
        ring = []
        for s in range(sides + 1):
            a = 2 * math.pi * s / sides
            nrm = add((side[0] * math.cos(a), side[1] * math.cos(a), side[2] * math.cos(a)), up, math.sin(a))
            flute = 1.0 + (0.08 * math.sin(a * 5) if sp['bark'] == 'smooth' and br.depth <= 1 else 0.0)
            p = add(path[i], nrm, r * flute)
            col = bark_tone(sp['bark'], p, a, vnoise)
            sw = sway_at(sp, p) * (0.55 if br.depth <= 1 else 0.9)
            ring.append(m.vert(p, nrm, col + (1.0,), (s / sides, length / 2.0), (0, sw, br.phase, p[1] / total)))
        rings.append(ring)
    for i in range(n - 1):
        for s in range(sides):
            a, b, c2, d2 = rings[i][s], rings[i][s + 1], rings[i + 1][s + 1], rings[i + 1][s]
            m.I += [a, c2, b, a, d2, c2]


def card(m, sp, centre, size, rng, cell, phase, total, crown_c):
    """One leaf card: a quad facing mostly out of the crown, a cluster of leaves from the atlas cell on it."""
    rx, ry, rz = sp['radii']
    rel = sub(centre, crown_c)
    outward = norm((rel[0] / rx ** 2, rel[1] / ry ** 2, rel[2] / rz ** 2))
    n = norm(add(add(outward, (rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)), 0.75), (0, 1, 0), 0.35))
    t = norm(cross(n, (rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))))
    b = cross(n, t)
    # How deep in the crown it hangs: 0 on the shell, 1 at the centre; under the crown is darker.
    depth = max(0.0, 1.0 - math.sqrt((rel[0] / rx) ** 2 + (rel[1] / ry) ** 2 + (rel[2] / rz) ** 2))
    under = max(0.0, min(1.0, (centre[1] - (crown_c[1] - ry)) / (2 * ry)))
    shade = max(0.42, min(1.0, (1.0 - 0.7 * depth) * (0.7 + 0.3 * under)))
    flip = rng.random() < 0.5
    cu = (cell % 2) * 0.5
    cv = (cell // 2) * 0.5
    idx = []
    for (su, sv) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        p = add(add(centre, t, su * size * 0.5), b, sv * size * 0.5)
        r = sub(p, crown_c)
        radial = norm((r[0] / rx ** 2, r[1] / ry ** 2, r[2] / rz ** 2))
        vn = norm(add((radial[0] * 0.8, radial[1] * 0.8, radial[2] * 0.8), n, 0.2))
        if flip:
            u = cu + 0.5 - (su * 0.5 + 0.5) * 0.5
        else:
            u = cu + (su * 0.5 + 0.5) * 0.5
        v = cv + (sv * 0.5 + 0.5) * 0.5
        sw = sway_at(sp, p)
        idx.append(m.vert(p, vn, (shade, shade, shade, 1.0), (u, v), (1, sw, phase, p[1] / total)))
    a, b2, c2, d2 = idx
    m.I += [a, b2, c2, a, c2, d2]


def leaves(m, sp, tips, rng, count, size, total):
    c = sp['centre']
    salt = sp['seed'] * 0.37
    # Two thirds of the cards round the twig tips, a third over the shell to close the gaps between them.
    near = int(count * 0.66)
    for i in range(near):
        tip, phase = tips[i % len(tips)]
        off = (rng.gauss(0, 0.55), rng.gauss(0, 0.45), rng.gauss(0, 0.55))
        p = add(tip, off, size / 1.4)
        card(m, sp, p, size * rng.uniform(0.85, 1.15), rng, rng.randrange(4), phase, total, c)
    golden = math.pi * (3 - math.sqrt(5))
    rest = count - near
    for i in range(rest):
        y = 1 - 2 * (i + 0.5) / rest
        y = y * 0.92 + 0.04  # fewer underneath
        r = math.sqrt(max(0.0, 1 - y * y))
        a = i * golden
        d = norm((math.cos(a) * r, y, math.sin(a) * r))
        p = shell_point(sp, d, rng.uniform(0.8, 0.97), salt)
        # The nearest tip's phase, so a card moves with the twigs round it.
        ph = min(tips, key=lambda tp: dot(sub(tp[0], p), sub(tp[0], p)))[1]
        card(m, sp, p, size * rng.uniform(0.9, 1.2), rng, rng.randrange(4), ph, total, c)


def build(name, level):
    sp, branches, tips = grow(name)
    rng = random.Random(sp['seed'] * 101 + (0 if level == 'near' else 1))
    m = Mesh()
    total = sp['height']
    for br in branches:
        if br.depth == 3:
            # The twigs are lost in their own leaves: they place the cards, and draw nothing.
            continue
        if level == 'far':
            # Past the near radius the limbs are lost in the crown: the bole alone, on its end points.
            if br.depth > 0:
                continue
            br = Branch([br.path[0], br.path[len(br.path) // 2], br.path[-1]], br.r0, br.r1, 0, br.phase)
        sides = {0: 8, 1: 6, 2: 4, 3: 3}[br.depth] if level == 'near' else 5
        tube(m, sp, br, sides, total)
    if level == 'near':
        leaves(m, sp, tips, rng, sp['cards'], sp['card'], total)
    else:
        leaves(m, sp, tips, rng, sp['far_cards'], sp['card'] * 1.9, total)
    return m


# ---------------------------------------------------------------- the writer


def pack(m):
    P = np.array(m.P, dtype=np.float64)
    N = np.array(m.N, dtype=np.float64)
    C = np.array(m.C, dtype=np.float64)
    UV = np.array(m.UV, dtype=np.float64)
    TR = np.array(m.T, dtype=np.float64)
    I = np.array(m.I, dtype=np.uint32)
    lo = P.min(0)
    hi = P.max(0)
    centre = (lo + hi) / 2
    half = np.maximum((hi - lo) / 2, 1e-6)
    q = np.zeros((len(P), 4), dtype=np.int16)
    q[:, :3] = np.round(np.clip((P - centre) / half, -1, 1) * 32767).astype(np.int16)
    nrm = np.zeros((len(N), 4), dtype=np.int8)
    nrm[:, :3] = np.round(np.clip(N, -1, 1) * 127).astype(np.int8)
    col = np.round(np.clip(C, 0, 1) * 255).astype(np.uint8)
    # Bark runs along its branch past 1: kept as a fraction of its own repeat (the shader's bark mottle tiles).
    uv = UV.copy()
    uv[:, 1] = np.mod(uv[:, 1], 1.0)
    uvq = np.round(np.clip(uv, 0, 1) * 65535).astype(np.uint16)
    tree = np.column_stack([TR[:, 0], np.round(np.clip(TR[:, 1], 0, 1) * 255), np.round(np.mod(TR[:, 2], 1.0) * 255), np.round(np.clip(TR[:, 3], 0, 1) * 255)]).astype(np.uint8)
    T = I.astype(np.uint16 if len(P) < 65536 else np.uint32)
    return q, nrm, col, uvq, tree, T, [float(x) for x in centre], [float(x) for x in half]


def write_glb(path, meshes):
    blob = bytearray()
    views = []
    accessors = []
    nodes = []
    gmeshes = []

    def put(data, target, count, ctype, typ, normalized=False, stride=None, minmax=None):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        b = data.tobytes()
        blob.extend(b)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(b)}
        if stride:
            v['byteStride'] = stride
        views.append(v)
        a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': count, 'type': typ}
        if normalized:
            a['normalized'] = True
        if minmax:
            a['min'], a['max'] = minmax
        accessors.append(a)
        return len(accessors) - 1

    for name, (P, nrm, col, uv, tree, T, centre, half) in meshes.items():
        n = len(P)
        attrs = {
            'POSITION': put(P, 34962, n, 5122, 'VEC3', normalized=True, stride=8, minmax=(P[:, :3].min(0).tolist(), P[:, :3].max(0).tolist())),
            'NORMAL': put(nrm, 34962, n, 5120, 'VEC3', normalized=True, stride=4),
            'COLOR_0': put(col, 34962, n, 5121, 'VEC4', normalized=True),
            'TEXCOORD_0': put(uv, 34962, n, 5123, 'VEC2', normalized=True),
            '_TREE': put(tree, 34962, n, 5121, 'VEC4'),
        }
        ind = put(T, 34963, T.size, 5123 if T.dtype == np.uint16 else 5125, 'SCALAR')
        gmeshes.append({'primitives': [{'attributes': attrs, 'indices': ind, 'mode': 4}]})
        nodes.append({'name': name, 'mesh': len(gmeshes) - 1, 'translation': centre, 'scale': half})
    while len(blob) % 4:
        blob.append(0)
    doc = {
        'asset': {'version': '2.0'},
        'extensionsUsed': ['KHR_mesh_quantization'],
        'extensionsRequired': ['KHR_mesh_quantization'],
        'scene': 0,
        'scenes': [{'nodes': list(range(len(nodes)))}],
        'nodes': nodes,
        'meshes': gmeshes,
        'accessors': accessors,
        'bufferViews': views,
        'buffers': [{'byteLength': len(blob)}],
    }
    js = json.dumps(doc, separators=(',', ':')).encode()
    while len(js) % 4:
        js += b' '
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546C67, 2, total))
        fh.write(struct.pack('<II', len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(struct.pack('<II', len(blob), 0x004E4942))
        fh.write(bytes(blob))
    return total


TREES_BUDGET = 600_000  # test/trees.test.ts: trees.glb's own cap


def write(out):
    meshes = {}
    tris = {}
    for name in SPECIES:
        for level in ('near', 'far'):
            m = build(name, level)
            meshes[f'{name}.{level}'] = pack(m)
            tris[f'{name}.{level}'] = len(m.I) // 3
    size = write_glb(out, meshes)
    assert size <= TREES_BUDGET, f'trees.glb is {size} bytes, over its {TREES_BUDGET} cap'
    print(f'trees: {", ".join(f"{k} {v}" for k, v in tris.items())} triangles, {size} bytes -> {out}')


if __name__ == '__main__':
    write(sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'trees.glb')
