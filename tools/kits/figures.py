"""
Palimpsest's people, modelled in Blender from code: one clothed, sculpted
figure (a head with its features, hands, a coat with its seams and folds,
trousers, shoes) and the variants a crowd wears (four heads of hair, two
hats, a scarf), written to app/public/kits/figures.glb at two levels.

Run headless (never with a UI):

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python tools/kits/figures.py -- app/public/kits/figures.glb

How it is made. Every part is a signed distance field sculpted from smooth
blends of ellipsoids and round cones, carved (eye sockets, nostrils, the
mouth line, the coat's V), displaced (folds) and grooved (seams), then
meshed by OpenVDB at a millimetre or two, cleaned and decimated in Blender
to the part's triangle budget, its normals taken from the field itself.
Per vertex the script then works out the rig (two bones and a weight, as
ambient.ts names them), the surface code, the variant part, the coat tail
measure and a baked ambient occlusion (rays against the rest pose in
Blender's BVH). Nothing is random without a fixed seed, so the same script
writes the same file.

Frame: three.js, metres, a 1.75 m figure standing at the origin facing +x,
y up, its left side at -z (ambient.ts JOINT). The GLB is written by a small
writer below (not the glTF exporter) so the layout is compact and fixed:
one mesh per level, `figure.hi` and `figure.lo`, each with

    POSITION  float32 x3
    NORMAL    int8 normalized x3 (+1 pad)      KHR_mesh_quantization
    _SKIN     uint8 x4: bone a, bone b, weight of b (/255), blush (/255)
    _SURF     uint8 x4: surface code, variant part, coat tail (/255), occlusion (/255)
    indices   uint16
"""

import json
import math
import struct
import sys

import bmesh
import bpy
import numpy as np
import openvdb as vdb
from mathutils import Vector
from mathutils.bvhtree import BVHTree

f32 = np.float32

# ---------------------------------------------------------------- the rig (ambient.ts JOINT and B)

JOINT = {
    'hip': (0, 0.92, 0.095),
    'knee': (0.01, 0.5, 0.095),
    'ankle': (0, 0.085, 0.095),
    'shoulder': (0, 1.43, 0.195),
    'elbow': (-0.01, 1.15, 0.215),
    'wrist': (0.01, 0.89, 0.215),
    'neck': (0, 1.52, 0),
}
BONE = {'body': 0, 'head': 1, 'thighL': 2, 'shinL': 3, 'thighR': 4, 'shinR': 5, 'armL': 6, 'foreL': 7, 'armR': 8, 'foreR': 9}
CODE = {'skin': 0, 'hair': 1, 'coat': 2, 'legs': 3, 'shoes': 4, 'button': 5, 'eye': 7, 'trim': 8, 'lip': 9, 'hat': 10, 'scarf': 11, 'shirt': 12, 'sole': 13}
# Variant parts: 0 always worn; the rest shown by the instance (ambient.ts FIGURE_GLSL `worn`).
PART = {'base': 0, 'buzz': 1, 'short': 2, 'long': 3, 'bun': 4, 'hat': 5, 'cap': 6, 'scarf': 7}

# ---------------------------------------------------------------- fields


def v3(a):
    return np.asarray(a, dtype=f32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def smin(a, b, k):
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def ellip(c, r):
    c = v3(c)
    r = v3(r)

    def f(X, Y, Z):
        x = (X - c[0]) / r[0]
        y = (Y - c[1]) / r[1]
        z = (Z - c[2]) / r[2]
        k0 = np.sqrt(x * x + y * y + z * z)
        k1 = np.sqrt((x / r[0]) ** 2 + (y / r[1]) ** 2 + (z / r[2]) ** 2)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-6)
    return f


def cone(a, b, ra, rb):
    """A round cone: a capsule from a (radius ra) to b (radius rb)."""
    a = v3(a)
    b = v3(b)
    ba = b - a
    l2 = float(ba @ ba)
    rr = ra - rb
    a2 = l2 - rr * rr
    il2 = 1.0 / l2

    def f(X, Y, Z):
        px = X - a[0]
        py = Y - a[1]
        pz = Z - a[2]
        y = px * ba[0] + py * ba[1] + pz * ba[2]
        z = y - l2
        qx = px * l2 - ba[0] * y
        qy = py * l2 - ba[1] * y
        qz = pz * l2 - ba[2] * y
        x2 = qx * qx + qy * qy + qz * qz
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        d1 = np.sqrt(x2 + z2) * il2 - rb
        d2 = np.sqrt(x2 + y2) * il2 - ra
        d3 = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - ra
        return np.where(np.sign(z) * a2 * z2 > k, d1, np.where(np.sign(y) * a2 * y2 < k, d2, d3))
    return f


def rbox(c, h, r):
    c = v3(c)
    h = v3(h)

    def f(X, Y, Z):
        qx = np.abs(X - c[0]) - h[0] + r
        qy = np.abs(Y - c[1]) - h[1] + r
        qz = np.abs(Z - c[2]) - h[2] + r
        o = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
        return o + np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0) - r
    return f


def turned(f, c, rx=0.0, ry=0.0, rz=0.0):
    """f turned about c (Euler XYZ, radians): evaluated in the field's own frame."""
    c = v3(c)
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    R = (Rz @ Ry @ Rx).T.astype(f32)

    def g(X, Y, Z):
        x = X - c[0]
        y = Y - c[1]
        z = Z - c[2]
        return f(R[0, 0] * x + R[0, 1] * y + R[0, 2] * z + c[0], R[1, 0] * x + R[1, 1] * y + R[1, 2] * z + c[1], R[2, 0] * x + R[2, 1] * y + R[2, 2] * z + c[2])
    return g


def mirrored(f):
    """f made on the right (+z) and mirrored to the left."""
    return lambda X, Y, Z: f(X, Y, np.abs(Z))


def groove(dist, w, depth):
    """A seam's groove: deepest on its line, gone a few widths off it."""
    return depth * np.exp(-(dist / w) ** 2)


def wave(*args):
    """A fixed sum of sines: an organic but repeatable ripple."""
    s = 0.0
    for amp, fr, ph, coord in args:
        s = s + amp * np.sin(fr * coord + ph)
    return s


# ---------------------------------------------------------------- the head

EYE = (0.079, 1.669, 0.032)
EYE_R = 0.0122


def head_field(X, Y, Z):
    Za = np.abs(Z)
    d = ellip((-0.016, 1.676, 0), (0.1, 0.097, 0.077))(X, Y, Z)
    # The face: forehead, cheeks and jaw, narrowing to the chin.
    d = smin(d, ellip((0.03, 1.618, 0), (0.074, 0.08, 0.062))(X, Y, Z), 0.035)
    d = smin(d, ellip((0.06, 1.64, 0.044), (0.024, 0.014, 0.022))(X, Y, Za), 0.03)
    d = smin(d, cone((-0.018, 1.596, 0.05), (0.068, 1.55, 0.014), 0.018, 0.013)(X, Y, Za), 0.03)
    d = smin(d, ellip((0.086, 1.553, 0), (0.019, 0.018, 0.02))(X, Y, Z), 0.018)
    d = smin(d, ellip((0.05, 1.605, 0.036), (0.026, 0.026, 0.018))(X, Y, Za), 0.03)
    # The brow ridge over the eyes, and the sockets under it.
    d = smin(d, cone((0.084, 1.69, 0.0), (0.068, 1.692, 0.042), 0.0085, 0.005)(X, Y, Za), 0.016)
    d = smax(d, -ellip((0.096, 1.668, 0.033), (0.017, 0.0115, 0.0165))(X, Y, Za), 0.012)
    # Lids: a shell over the eyeball, open in a band across it.
    # The opening is an almond: widest a little outside the pupil, closed at the corners, only in front.
    ey = Y - EYE[1] - 0.0008
    zz = (Za - EYE[2] - 0.001) / 0.0128
    h = np.clip(1.0 - zz * zz, 0.0, 1.0) ** 0.6
    lid = ellip(EYE, (EYE_R + 0.0017,) * 3)(X, Y, Za)
    upper = 0.0036 * h - 0.0010 * zz
    lower = -0.0029 * h - 0.0005 * zz
    open_band = np.maximum(np.maximum(ey - upper, lower - ey), np.maximum(EYE[0] + 0.004 - X, np.abs(zz) - 1.0) * 0.5)
    d = smin(d, np.maximum(lid, -open_band), 0.0055)
    # The muzzle under the nose, then the nose: a bridge, the tip and the wings, the nostrils.
    d = smin(d, ellip((0.07, 1.598, 0), (0.04, 0.031, 0.035))(X, Y, Z), 0.02)
    nose = cone((0.095, 1.676, 0), (0.116, 1.624, 0), 0.0075, 0.0105)(X, Y, Z)
    nose = smin(nose, ellip((0.116, 1.619, 0), (0.0125, 0.0115, 0.0115))(X, Y, Z), 0.008)
    nose = smin(nose, ellip((0.104, 1.6135, 0.0125), (0.0105, 0.0085, 0.008))(X, Y, Za), 0.006)
    d = smin(d, nose, 0.008)
    d = smax(d, -ellip((0.11, 1.6065, 0.0072), (0.0048, 0.0022, 0.0034))(X, Y, Za), 0.0018)
    # The lips, the line between them and the philtrum over them.
    lips = smin(ellip((0.098, 1.5925, 0), (0.0095, 0.006, 0.0215))(X, Y, Z), ellip((0.095, 1.5795, 0), (0.0095, 0.0072, 0.018))(X, Y, Z), 0.004)
    d = smin(d, lips, 0.008)
    d = smax(d, -np.maximum(ellip((0.105, 1.5862, 0), (0.0125, 0.0011, 0.0175))(X, Y, Z), 0.093 - X), 0.0014)
    d = smax(d, -ellip((0.1065, 1.602, 0), (0.0035, 0.0075, 0.0022))(X, Y, Z), 0.002)
    # The ears: a shell with its rim, the hollow of the concha.
    ear = turned(ellip((-0.008, 1.656, 0.077), (0.021, 0.032, 0.0095)), (-0.008, 1.656, 0.077), 0, 0.1, -0.16)
    ear_in = turned(ellip((-0.004, 1.65, 0.0865), (0.0125, 0.019, 0.007)), (-0.004, 1.65, 0.0865), 0, 0.1, -0.16)
    e = smax(ear(X, Y, Za), -ear_in(X, Y, Za), 0.004)
    d = smin(d, e, 0.006)
    # The neck, the muscles from behind the ear to the collarbone.
    d = smin(d, cone((-0.02, 1.43, 0), (-0.01, 1.6, 0), 0.064, 0.055)(X, Y, Z), 0.03)
    d = smin(d, cone((-0.012, 1.605, 0.05), (0.035, 1.46, 0.014), 0.012, 0.013)(X, Y, Za), 0.018)
    return d


def head_lip(X, Y, Z):
    lips = smin(ellip((0.098, 1.5925, 0), (0.0095, 0.006, 0.0215))(X, Y, Z), ellip((0.095, 1.5795, 0), (0.0095, 0.0072, 0.018))(X, Y, Z), 0.004)
    return (lips < 0.0045) & (X > 0.083)


def head_blush(X, Y, Z):
    Za = np.abs(Z)
    cheek = np.exp(-(((X - 0.08) / 0.03) ** 2 + ((Y - 1.625) / 0.025) ** 2 + ((Za - 0.042) / 0.025) ** 2))
    nose = np.exp(-(((X - 0.118) / 0.015) ** 2 + ((Y - 1.618) / 0.015) ** 2 + (Z / 0.016) ** 2))
    ear = np.exp(-(((Y - 1.655) / 0.03) ** 2 + ((Za - 0.085) / 0.012) ** 2))
    return np.clip(0.7 * cheek + 0.6 * nose + 0.55 * ear, 0, 1)


def eye_field(X, Y, Z):
    return ellip(EYE, (EYE_R,) * 3)(X, Y, np.abs(Z))


# ---------------------------------------------------------------- hair and hats

CRAN = ((-0.016, 1.676, 0), (0.1, 0.097, 0.077))


def scalp(grow):
    c, r = CRAN
    return ellip(c, (r[0] + grow, r[1] + grow, r[2] + grow))


def hairline(X, Y, Z, nape):
    """Positive (in metres) where hair grows: a continuous line over the brow, down past the temples to the sideburn, round the ears, to the nape."""
    Za = np.abs(Z)
    side = 1.735 - 0.06 * smoothstep(0.02, 0.078, Za) * smoothstep(0.1, 0.02, X)
    line = side + (nape - side) * smoothstep(0.0, -0.075, X)
    grows = Y - line
    ear = (np.sqrt(((X + 0.006) / 0.03) ** 2 + ((Y - 1.652) / 0.042) ** 2) - 1.0) * 0.03
    return smin(grows, np.where(Za > 0.05, ear, 1.0), 0.006)


def strands(X, Y, Z, k=1.0):
    """Hair masses: clumps combed back from a side parting, and finer strands within them."""
    a = np.arctan2(Z + 0.02, X + 0.03)
    clumps = wave((0.0017, 11.0, 0.4, a), (0.001, 19.0, 1.7, a + 2.0 * Y), (0.0005, 31.0, 0.3, a - 3.0 * Y))
    return k * clumps


def hair_buzz(X, Y, Z):
    d = scalp(0.0025)(X, Y, Z)
    return np.maximum(d, -hairline(X, Y, Z, 1.6)) + 0.0002 * np.sin(900 * X) * np.sin(900 * Z)


def hair_short(X, Y, Z):
    top = smoothstep(1.66, 1.76, Y)
    line = hairline(X, Y, Z, 1.598)
    fade = smoothstep(-0.002, 0.014, line)
    d = scalp(0.0006 + (0.0034 + 0.009 * top) * fade)(X, Y, Z) - strands(X, Y, Z) * fade
    # The side parting: a groove front to back on the left.
    d = d + groove(np.abs(Z + 0.028), 0.003, 0.003) * smoothstep(-0.06, 0.04, X) * smoothstep(1.72, 1.76, Y)
    return smax(d, -line, 0.002)


def hair_long(X, Y, Z):
    d = hair_short(X, Y, Z)
    # A fall of hair from the crown over the nape to the shoulders, parted in vertical locks.
    fall = cone((-0.055, 1.66, 0), (-0.07, 1.46, 0), 0.085, 0.07)(X, Y, Z * 1.05)
    fall = smax(fall, -(0.03 - X), 0.03)
    fall = smax(fall, -(1.72 - Y), 0.02)
    a = np.arctan2(Z, -X)
    fall = fall - wave((0.003, 9.0, 0.5, a), (0.0018, 17.0, 1.2, a + 4 * Y), (0.0006, 60.0, 0.0, a))
    # Keep it off the face and clear of the neck.
    fall = smax(fall, -scalp(0.002)(X, Y, Z), 0.003)
    return smin(d, fall, 0.02)


def hair_bun(X, Y, Z):
    top = smoothstep(1.66, 1.76, Y)
    line = hairline(X, Y, Z, 1.6)
    fade = smoothstep(-0.002, 0.014, line)
    d = scalp(0.0006 + (0.0024 + 0.004 * top) * fade)(X, Y, Z) - 0.5 * strands(X, Y, Z) * fade
    d = smax(d, -line, 0.002)
    a = np.arctan2(Y - 1.7, Z)
    bun = ellip((-0.105, 1.705, 0), (0.03, 0.034, 0.036))(X, Y, Z) - wave((0.0016, 7.0, 0.0, a + 30 * X))
    return smin(d, bun, 0.012)


def hat_brim(X, Y, Z):
    """A soft felt hat: a pinched crown, a ribbon, a brim turned down at the front."""
    c = (-0.012, 1.72, 0)
    crown = ellip((c[0], 1.76, 0), (0.105, 0.065, 0.088))(X, Y, Z)
    crown = smax(crown, -(Y - 1.708), 0.01)
    crown = smax(crown, -ellip((0.0, 1.835, 0), (0.07, 0.02, 0.012))(X, Y, Z), 0.012)
    r = np.sqrt(((X - c[0]) / 1.12) ** 2 + (Z / 1.0) ** 2)
    droop = 0.012 * smoothstep(0.0, 0.1, X) - 0.006 * smoothstep(0.0, -0.1, X)
    brim = np.maximum(np.abs(Y - 1.71 + droop) - 0.003, r - 0.152)
    brim = smax(brim, -(r - 0.07), 0.002)
    d = smin(crown, brim, 0.008)
    band = np.maximum(np.abs(Y - 1.722) - 0.009, crown - 0.0018)
    return d, band


def hat_cap(X, Y, Z):
    """A flat cap: a soft crown pulled forward over a short peak."""
    crown = ellip((0.01, 1.735, 0), (0.115, 0.05, 0.088))(X, Y, Z)
    crown = smax(crown, -(Y - 1.7 - 0.02 * smoothstep(0.0, 0.1, X)), 0.006)
    crown = crown + groove(Z, 0.002, 0.0015) * smoothstep(0.0, 0.05, X)
    peak = np.maximum(np.abs(Y - 1.708 + 0.25 * (X - 0.09)) - 0.003, ellip((0.1, 1.7, 0), (0.06, 0.05, 0.075))(X, Y, Z))
    peak = np.maximum(peak, 0.06 - X)
    return smin(crown, peak, 0.006)


def scarf_field(X, Y, Z):
    """A knitted scarf, wrapped once round the neck, its ends tucked into the coat's V."""
    a = np.arctan2(Z, X + 0.005)
    rr = np.sqrt((X + 0.012) ** 2 + Z ** 2)
    yc = 1.485 - 0.025 * np.cos(a)
    tube = np.sqrt((rr - 0.07) ** 2 + ((Y - yc) / 1.3) ** 2) - 0.022
    ends = rbox((0.088, 1.35, 0.0), (0.012, 0.11, 0.032), 0.01)(X, Y, Z - 0.008 * np.sin(18 * Y))
    d = smin(tube, ends, 0.02)
    rib = 0.0012 * np.sin(a * 46) + 0.0008 * np.sin(Y * 520)
    return d - rib


# ---------------------------------------------------------------- the clothes

SHO = v3(JOINT['shoulder'])
ELB = v3(JOINT['elbow'])
WRI = v3(JOINT['wrist'])
HEM = 0.8  # the coat's hem at rest (a hip-length coat); the instance lengthens the tail below the waist
WAIST = 0.975
POCKETS = False  # flap pockets at the hips: noise at this size, left off


def v_half(Y):
    """The coat's opening: the V's half width at height Y (0 below the top button)."""
    return 0.058 * np.clip((Y - 1.23) / (1.47 - 1.23), 0, 1) ** 1.1


def coat_field(X, Y, Z):
    Za = np.abs(Z)
    # The torso: chest, ribcage to waist, shoulders and upper back, the seat of the coat.
    d = ellip((0.004, 1.285, 0), (0.12, 0.2, 0.162))(X, Y, Z)
    d = smin(d, ellip((-0.004, 1.06, 0), (0.108, 0.17, 0.152))(X, Y, Z), 0.06)
    d = smin(d, ellip((-0.035, 1.31, 0.0), (0.095, 0.15, 0.165))(X, Y, Z), 0.04)
    d = smin(d, cone((-0.012, 1.468, 0.055), (-0.006, 1.425, 0.19), 0.04, 0.05)(X, Y, Za), 0.05)
    # The skirt: a flared shell from the waist to the hem, open at the front and with a vent at the back.
    t = np.clip((WAIST - Y) / (WAIST - HEM), 0, 1)
    rx = 0.112 + 0.016 * t
    rz = 0.165 + 0.02 * t
    # Solid below the waist (only its outside is ever seen), so decimation keeps it whole.
    shell = (np.sqrt((X / rx) ** 2 + (Z / rz) ** 2) - 1.0) * 0.12
    shell = np.maximum(shell, np.maximum(HEM - Y, Y - (WAIST + 0.04)))
    front = np.maximum(0.003 - np.abs(Z + 0.006 * smoothstep(0.98, 0.8, Y)), 0.03 - X)
    back = np.maximum(0.003 - Za, X + 0.05)
    shell = smax(shell, -np.minimum(np.where(Y < 0.955, front, 1.0), np.where(Y < 0.9, back, 1.0)), 0.002)
    d = smin(d, shell, 0.03)
    # The armholes, so the sleeves sit in them.
    d = smax(d, -cone(SHO + v3((0, 0.015, 0.012)), SHO + v3((0, -0.11, 0.025)), 0.052, 0.045)(X, Y, Za), 0.012)
    # The V: carved to the shirt beneath; the lapels laid either side of it.
    vw = v_half(Y)
    carve = np.maximum(Za - vw, 0.02 - X)
    carve = np.maximum(carve, 1.23 - Y)
    d = smax(d, -carve, 0.004)
    shirt = ellip((-0.006, 1.32, 0), (0.104, 0.17, 0.13))(X, Y, Z)
    shirt = np.maximum(shirt, carve - 0.01)
    lapel_in = Za - vw
    lapel = np.maximum(np.maximum(-lapel_in, lapel_in - 0.022 - 0.016 * np.clip((Y - 1.25) / 0.2, 0, 1)), np.maximum(1.22 - Y, Y - 1.455))
    surf = ellip((0.004, 1.285, 0), (0.124, 0.2, 0.164))(X, Y, Z)
    lapel = np.maximum(lapel, np.abs(surf - 0.002) - 0.0025)
    # The notch where lapel meets collar.
    lapel = smax(lapel, -ellip((0.09, 1.442, 0.072), (0.02, 0.012, 0.012))(X, Y, Za), 0.002)
    # The collar: a band standing round the back of the neck and falling over itself.
    a = np.arctan2(Za, -(X + 0.01))
    rr = np.sqrt((X + 0.012) ** 2 + Z ** 2)
    ytop = 1.565 - 0.075 * smoothstep(1.4, 2.4, a)
    collar = np.maximum(np.abs(rr - 0.068 - 0.25 * np.maximum(1.5 - Y, 0)) - 0.005, np.maximum(1.455 - Y, Y - ytop))
    collar = smax(collar, (a - 2.25) * 0.03, 0.004)
    d = smin(d, lapel, 0.003)
    d = smin(d, collar, 0.01)
    d = smin(d, shirt, 0.002)
    # Pocket flaps at the hips.
    fl = np.maximum((np.sqrt((X / 0.124) ** 2 + (Z / 0.178) ** 2) - 1.0) * 0.12 - 0.003, np.maximum(np.abs(Y - 0.905) - 0.021, np.abs(Za - 0.11) - 0.058))
    fl = np.maximum(fl, -X)
    d = smin(d, fl, 0.002) if POCKETS else d
    # Seams: over each shoulder, down each side and the centre back, round the waist.
    shoulder_seam = groove(X + 0.008, 0.0022, 0.0018) * smoothstep(1.4, 1.43, Y) * smoothstep(0.065, 0.08, Za)
    side_seam = groove(X + 0.02, 0.0022, 0.0016) * smoothstep(1.32, 1.3, Y) * smoothstep(0.1, 0.14, Za)
    back_seam = groove(Z, 0.002, 0.0016) * smoothstep(-0.05, -0.08, X) * smoothstep(1.48, 1.45, Y)
    waist_seam = groove(Y - WAIST, 0.0022, 0.0014) * smoothstep(0.0, -0.04, X)
    d = d + shoulder_seam + side_seam + back_seam + waist_seam
    # Folds: drag lines from the button to the sides, drape down the back, and fuller folds in the skirt.
    drag = wave((0.0016, 60.0, 0.0, Y + 0.55 * Za), (0.0008, 110.0, 1.3, Y - 0.3 * Za)) * smoothstep(1.24, 1.0, Y) * smoothstep(0.85, 1.0, Y) * smoothstep(0.0, 0.05, X) * smoothstep(0.02, 0.09, Za)
    back = wave((0.0018, 34.0, 0.7, Z), (0.0009, 71.0, 0.2, Z + 0.4 * Y)) * smoothstep(-0.04, -0.09, X) * smoothstep(1.4, 1.18, Y) * smoothstep(0.98, 1.1, Y)
    ang = np.arctan2(Z, X)
    skirt = (0.0024 * np.sin(ang * 9 + 0.6 * np.sin(ang * 3)) + 0.0012 * np.sin(ang * 17 + 1.1)) * t
    d = d - drag - back - skirt
    return d


def coat_codes(X, Y, Z):
    Za = np.abs(Z)
    vw = v_half(Y)
    shirt = (Za < vw + 0.0005) & (Y > 1.23) & (X > 0.02)
    return np.where(shirt, CODE['shirt'], CODE['coat'])


def sleeve_field(X, Y, Z):
    """The right sleeve (mirrored for the left): set into the armhole, folds at the inner elbow, a turned cuff."""
    d = cone(SHO + v3((-0.004, -0.01, -0.004)), ELB, 0.052, 0.047)(X, Y, Z)
    d = smin(d, cone(ELB, WRI + v3((0.0, -0.01, 0)), 0.046, 0.043)(X, Y, Z), 0.02)
    # The cuff's opening, so the wrist goes into it.
    d = smax(d, -cone(WRI + v3((0, 0.05, 0)), WRI + v3((0, -0.03, 0)), 0.034, 0.039)(X, Y, Z), 0.003)
    d = np.maximum(d, (WRI[1] - 0.01) - Y)
    # Folds where the elbow bends (in front), easing to drape on the forearm.
    u = Y - ELB[1]
    front = smoothstep(-0.01, 0.03, X - ELB[0])
    ang = np.arctan2(Z - ELB[2], X - ELB[0])
    elbow = (0.0026 * np.sin(u * 230 + 2.2 * ang) + 0.0012 * np.sin(u * 410 - ang)) * np.exp(-(u / 0.07) ** 2) * (0.35 + 0.65 * front)
    drape = 0.0012 * np.sin(ang * 5 + Y * 30) * smoothstep(1.4, 1.2, Y)
    d = d - elbow - drape
    # The cuff: a seam a few centimetres up, the back seam of the sleeve.
    d = d + groove(Y - WRI[1] - 0.05, 0.002, 0.0014)
    d = d + groove(Z - SHO[2] - 0.01 * (1.43 - Y), 0.0018, 0.0012) * smoothstep(0.0, -0.03, X - ELB[0])
    return d


def trouser_field(X, Y, Z):
    Za = np.abs(Z)
    hip = JOINT['hip']
    seat = ellip((-0.012, 0.93, 0), (0.108, 0.11, 0.162))(X, Y, Z)
    thigh = cone((0.0, 0.85, hip[2] + 0.005), (0.012, 0.5, hip[2]), 0.09, 0.06)(X, Y, Za)
    shin = cone((0.012, 0.5, hip[2]), (0.0, 0.035, hip[2] - 0.004), 0.06, 0.057)(X, Y, Za)
    d = smin(thigh, shin, 0.03)
    d = smin(d, seat, 0.05)
    d = smax(d, -(1.0 - Y), 0.01)
    d = smax(d, -(Y - 0.03), 0.004)
    # The front crease, folds behind the knee and the break over the shoe.
    lz = Za - hip[2]
    ang = np.arctan2(lz, X - 0.01)
    crease = groove(ang, 0.07, -0.0012) * smoothstep(0.9, 0.8, Y)
    knee = (0.0024 * np.sin((Y - 0.5) * 210 + 1.5 * ang)) * np.exp(-((Y - 0.49) / 0.06) ** 2) * smoothstep(0.3, -0.7, np.cos(ang))
    brk = (0.0028 * np.sin(Y * 140 + 0.8 * ang) + 0.001 * np.sin(Y * 300)) * smoothstep(0.2, 0.08, Y) * smoothstep(-0.2, 0.6, np.cos(ang))
    drape = 0.0012 * np.sin(ang * 4 + Y * 24) * smoothstep(0.95, 0.6, Y)
    d = d + crease - knee - brk - drape
    # The outside and inside leg seams.
    d = d + groove(X - 0.002, 0.0018, 0.0012) * smoothstep(0.015, 0.03, np.abs(lz)) * smoothstep(0.84, 0.78, Y)
    return d


def shoe_field(X, Y, Z):
    """A leather shoe, right foot (mirrored): sole, heel, vamp and toe cap, the welt between."""
    Za = np.abs(Z)
    z0 = JOINT['ankle'][2]
    z = Za - z0
    toe_in = 0.012 * smoothstep(0.08, 0.2, X)
    zz = z + toe_in
    sole = rbox((0.055, 0.012, 0), (0.13, 0.012, 0.043), 0.01)(X, Y, zz * (1.0 + 0.25 * smoothstep(0.1, 0.19, X)))
    heel = rbox((-0.045, 0.02, 0), (0.032, 0.02, 0.037), 0.008)(X, Y, zz)
    upper = ellip((-0.035, 0.055, 0), (0.05, 0.06, 0.04))(X, Y, zz)
    upper = smin(upper, ellip((0.07, 0.045, 0), (0.115, 0.043, 0.042))(X, Y, zz), 0.04)
    upper = smin(upper, ellip((0.15, 0.033, 0), (0.05, 0.03, 0.039))(X, Y, zz), 0.03)
    upper = smax(upper, 0.022 - Y, 0.004)
    d = smin(np.minimum(sole, heel), upper, 0.004)
    d = smax(d, Y - 0.11, 0.004)
    # The welt and the lace panel.
    d = d + groove(Y - 0.025, 0.0015, 0.0012) + groove(np.abs(zz) - 0.012, 0.0015, 0.0008) * smoothstep(0.02, 0.06, X) * smoothstep(0.12, 0.08, X) * smoothstep(0.05, 0.07, Y)
    return d


def shoe_codes(X, Y, Z):
    return np.where(Y < 0.024, CODE['sole'], CODE['shoes'])


def hand_field(X, Y, Z):
    """The right hand hanging relaxed (mirrored for the left): palm toward the thigh, fingers curled a little."""
    Za = np.abs(Z)
    wz = WRI[2]
    x0 = WRI[0]
    d = cone((x0, WRI[1] + 0.02, wz), (x0 + 0.002, WRI[1] - 0.01, wz), 0.026, 0.024)(X, Y, Za * 1.0 + (Za - wz) * 0.45)
    palm = rbox((x0 + 0.004, WRI[1] - 0.052, wz), (0.039, 0.04, 0.012), 0.011)(X, Y, Za)
    d = smin(d, palm, 0.012)
    d = smin(d, ellip((x0 + 0.03, WRI[1] - 0.045, wz - 0.009), (0.018, 0.028, 0.012))(X, Y, Za), 0.01)
    # Four fingers: three joints each, curling toward the palm (-z on the right hand).
    for i, (dx, ln, r) in enumerate(((0.027, 0.098, 0.0085), (0.009, 0.104, 0.009), (-0.009, 0.098, 0.0086), (-0.026, 0.08, 0.0076))):
        base = v3((x0 + dx, WRI[1] - 0.09, wz))
        segs = (0.45, 0.31, 0.24)
        bends = (0.25 + 0.04 * i, 0.42, 0.3)
        p = base
        ang = 0.0
        rad = r
        for s, b in zip(segs, bends):
            ang += b
            q = p + v3((dx * 0.12, -math.cos(ang) * ln * s, -math.sin(ang) * ln * s))
            d = smin(d, cone(p, q, rad, rad * 0.88)(X, Y, Za), 0.004)
            p = q
            rad *= 0.88
    # The thumb: from the heel of the palm, forward and down, alongside the index finger.
    t0 = v3((x0 + 0.03, WRI[1] - 0.028, wz - 0.01))
    t1 = t0 + v3((0.022, -0.03, -0.006))
    t2 = t1 + v3((0.012, -0.028, -0.008))
    d = smin(d, cone(t0, t1, 0.012, 0.0095)(X, Y, Za), 0.008)
    d = smin(d, cone(t1, t2, 0.0095, 0.008)(X, Y, Za), 0.004)
    # Knuckle creases.
    d = d + groove(Y - (WRI[1] - 0.092), 0.0015, 0.0006) * smoothstep(0.0, 0.006, Za - wz)
    return d


# ---------------------------------------------------------------- meshing


def mesh_field(name, fn, lo, hi, vox, adapt=0.0):
    """Evaluates fn on a grid and meshes its zero level with OpenVDB; returns (verts, faces) in metres."""
    lo = v3(lo)
    n = np.ceil((v3(hi) - lo) / vox).astype(int) + 1
    out = np.empty(n, dtype=f32)
    ys = lo[1] + np.arange(n[1], dtype=f32) * vox
    zs = lo[2] + np.arange(n[2], dtype=f32) * vox
    Y, Z = np.meshgrid(ys, zs, indexing='ij')
    for i in range(n[0]):
        X = np.full_like(Y, lo[0] + i * vox)
        out[i] = fn(X, Y, Z)
    g = vdb.FloatGrid(vox * 3)
    g.copyFromArray(out)
    pts, tris, quads = g.convertToPolygons(0.0, adapt)
    pts = pts.astype(np.float64) * vox + lo
    faces = [tuple(q) for q in quads.tolist()] + [tuple(t) for t in tris.tolist()]
    print(f'figures: {name} meshed {len(pts)} points, {len(faces)} faces')
    return pts, faces


def to_object(name, pts, faces):
    me = bpy.data.meshes.new(name)
    # Into Blender as (x, -z, y): Blender is z up, and the writer turns it back.
    me.from_pydata([(p[0], -p[2], p[1]) for p in pts], [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    return o


def decimate(o, tris):
    have = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if have > tris:
        m = o.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = tris / have
        m.use_symmetry = True
        m.symmetry_axis = 'Y'
        bpy.context.view_layer.objects.active = o
        for s in bpy.context.scene.objects:
            s.select_set(s == o)
        bpy.ops.object.modifier_apply(modifier='dec')
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()


def grad(fn, P, h=0.0004):
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    gx = fn(X + h, Y, Z) - fn(X - h, Y, Z)
    gy = fn(X, Y + h, Z) - fn(X, Y - h, Z)
    gz = fn(X, Y, Z + h) - fn(X, Y, Z - h)
    g = np.nan_to_num(np.stack([gx, gy, gz], 1))
    return g / np.maximum(np.linalg.norm(g, axis=1, keepdims=True), 1e-9)


# ---------------------------------------------------------------- per-vertex rig


def rig_of(part, P):
    """Bone a, bone b and the weight of b for each rest-pose point of a part."""
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    n = len(P)
    side = np.where(Z < 0, -1, 1)
    thigh = np.where(side < 0, BONE['thighL'], BONE['thighR'])
    shin = np.where(side < 0, BONE['shinL'], BONE['shinR'])
    arm = np.where(side < 0, BONE['armL'], BONE['armR'])
    fore = np.where(side < 0, BONE['foreL'], BONE['foreR'])
    a = np.zeros(n)
    b = np.zeros(n)
    w = np.zeros(n)
    tail = np.zeros(n)
    if part in ('head', 'eyes', 'hair', 'hat', 'scarf'):
        a[:] = BONE['body']
        b[:] = BONE['head']
        w = smoothstep(1.47, 1.555, Y)
        if part == 'scarf':
            w = w * 0.0
    elif part == 'coat':
        a[:] = BONE['body']
        b = thigh
        tail = np.clip((WAIST - Y) / (WAIST - HEM), 0, 1)
        w = 0.5 * tail * smoothstep(0.004, 0.05, np.abs(Z))
    elif part == 'sleeve':
        upper = Y > ELB[1] + 0.06
        a = np.where(upper, BONE['body'], arm)
        b = np.where(upper, arm, fore)
        w = np.where(upper, smoothstep(1.47, 1.385, Y), smoothstep(ELB[1] + 0.04, ELB[1] - 0.04, Y))
    elif part == 'hand':
        a = fore
        b = fore
    elif part == 'trousers':
        upper = Y > 0.62
        a = np.where(upper, BONE['body'], thigh)
        b = np.where(upper, thigh, shin)
        w = np.where(upper, smoothstep(1.0, 0.86, Y) * smoothstep(0.0, 0.045, np.abs(Z)), smoothstep(0.55, 0.45, Y))
    elif part == 'shoe':
        a = shin
        b = shin
    return a, b, w, tail


# ---------------------------------------------------------------- the parts

# name, field, bbox lo, bbox hi, voxel, part kind (rig), variant, triangles near, triangles far, codes
PARTS = [
    ('head', head_field, (-0.135, 1.41, -0.115), (0.145, 1.8, 0.115), 0.0013, 'head', 'base', 2700, 380),
    ('eyes', eye_field, (0.06, 1.65, -0.05), (0.095, 1.69, 0.05), 0.0007, 'eyes', 'base', 220, 24),
    ('coat', coat_field, (-0.17, 0.77, -0.24), (0.16, 1.56, 0.24), 0.0024, 'coat', 'base', 2900, 420),
    ('sleeve', sleeve_field, (-0.08, 0.84, 0.13), (0.08, 1.52, 0.3), 0.0022, 'sleeve', 'base', 700, 100),
    ('hand', hand_field, (-0.04, 0.73, 0.18), (0.07, 0.93, 0.25), 0.0008, 'hand', 'base', 650, 60),
    ('trousers', trouser_field, (-0.14, 0.02, -0.2), (0.14, 1.03, 0.2), 0.0026, 'trousers', 'base', 1700, 240),
    ('shoe', shoe_field, (-0.09, -0.005, 0.03), (0.2, 0.12, 0.16), 0.0013, 'shoe', 'base', 380, 60),
    ('hair_buzz', hair_buzz, (-0.13, 1.56, -0.095), (0.11, 1.79, 0.095), 0.0016, 'hair', 'buzz', 600, 90),
    ('hair_short', hair_short, (-0.135, 1.56, -0.1), (0.115, 1.8, 0.1), 0.0014, 'hair', 'short', 1000, 140),
    ('hair_long', hair_long, (-0.17, 1.42, -0.12), (0.115, 1.8, 0.12), 0.0016, 'hair', 'long', 1400, 200),
    ('hair_bun', hair_bun, (-0.15, 1.56, -0.1), (0.11, 1.79, 0.1), 0.0015, 'hair', 'bun', 1000, 140),
    ('hat_brim', None, (-0.18, 1.68, -0.17), (0.17, 1.84, 0.17), 0.0018, 'hat', 'hat', 900, 120),
    ('hat_cap', hat_cap, (-0.12, 1.68, -0.1), (0.17, 1.8, 0.1), 0.0016, 'hat', 'cap', 700, 100),
    ('scarf', scarf_field, (-0.11, 1.22, -0.11), (0.12, 1.54, 0.11), 0.0018, 'scarf', 'scarf', 900, 120),
]
# Parts made on the right only and mirrored (the meshing covers +z; the left is the same points with z turned).
MIRROR = {'sleeve', 'hand', 'shoe'}


def hat_brim_field(X, Y, Z):
    return hat_brim(X, Y, Z)[0]


def codes_of(name, P):
    X, Y, Z = P[:, 0], P[:, 1], P[:, 2]
    n = len(P)
    if name == 'head':
        return np.where(head_lip(X, Y, Z), CODE['lip'], CODE['skin'])
    if name == 'eyes':
        return np.full(n, CODE['eye'])
    if name == 'coat':
        return coat_codes(X, Y, Z)
    if name == 'sleeve':
        return np.full(n, CODE['coat'])
    if name == 'hand':
        return np.full(n, CODE['skin'])
    if name == 'trousers':
        return np.full(n, CODE['legs'])
    if name == 'shoe':
        return shoe_codes(X, Y, Z)
    if name.startswith('hair'):
        return np.full(n, CODE['hair'])
    if name == 'hat_brim':
        band = hat_brim(X, Y, Z)[1] < 0.0006
        return np.where(band, CODE['trim'], CODE['hat'])
    if name == 'hat_cap':
        return np.full(n, CODE['hat'])
    if name == 'scarf':
        return np.full(n, CODE['scarf'])
    return np.full(n, CODE['coat'])


def build():
    made = []
    for name, fn, lo, hi, vox, kind, variant, tri_hi, tri_lo in PARTS:
        if name == 'hat_brim':
            fn = hat_brim_field
        pts, faces = mesh_field(name, fn, lo, hi, vox)
        o = to_object(name, pts, faces)
        made.append((name, fn, kind, variant, tri_hi, tri_lo, o))
    return made


def take(o):
    """A triangulated object's points (three.js frame) and triangles."""
    me = o.data
    P = np.array([(v.co.x, v.co.z, -v.co.y) for v in me.vertices])
    T = np.array([tuple(p.vertices) for p in me.polygons], dtype=np.int64)
    return P, T


def level(made, lod):
    """Every part at one level: points, normals from the field, rig, codes and variant; mirrored parts doubled."""
    out = []
    for name, fn, kind, variant, tri_hi, tri_lo, o in made:
        c = o.copy()
        c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        decimate(c, tri_hi if lod == 'hi' else tri_lo)
        P, T = take(c)
        # The mesh's own normals, for any point where the field's gradient vanishes.
        c.data.update()
        M = np.array([(v.normal.x, v.normal.z, -v.normal.y) for v in c.data.vertices])
        bpy.data.objects.remove(c, do_unlink=True)
        sides = [1, -1] if name in MIRROR else [1]
        for s in sides:
            Q = P.copy()
            Q[:, 2] *= s
            U = T if s > 0 else T[:, ::-1]
            N = grad(fn, np.column_stack([Q[:, 0], Q[:, 1], Q[:, 2] * s]) if s < 0 else Q)
            if s < 0:
                N[:, 2] *= -1
            Ms = M.copy()
            Ms[:, 2] *= s
            bad = ~np.isfinite(N).all(1) | (np.linalg.norm(N, axis=1) < 0.5)
            N[bad] = Ms[bad]
            a, b, w, tail = rig_of(kind, Q)
            code = codes_of(name, np.column_stack([Q[:, 0], Q[:, 1], np.abs(Q[:, 2])]) if name in MIRROR else Q)
            blush = head_blush(Q[:, 0], Q[:, 1], Q[:, 2]) if name == 'head' else np.zeros(len(Q))
            if name == 'hand':
                blush = 0.35 * smoothstep(WRI[1] - 0.07, WRI[1] - 0.14, Q[:, 1])
            out.append({'name': name, 'variant': PART[variant], 'P': Q, 'N': N, 'T': U, 'a': a, 'b': b, 'w': w, 'tail': tail, 'code': code, 'blush': blush})
    return out


def occlusion(parts, rays=40):
    """Ambient occlusion per point, from rays over its hemisphere against the rest pose (the part's own variant and every base part)."""
    rng = np.random.default_rng(7)
    dirs = rng.normal(size=(rays, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    trees = {}

    def tree(variant):
        if variant in trees:
            return trees[variant]
        verts = []
        polys = []
        for p in parts:
            if p['variant'] in (0, variant):
                o = len(verts)
                verts += [tuple(x) for x in p['P'].tolist()]
                polys += [tuple(int(i) + o for i in t) for t in p['T']]
        trees[variant] = BVHTree.FromPolygons(verts, polys)
        return trees[variant]
    for p in parts:
        t = tree(p['variant'])
        ao = np.ones(len(p['P']))
        for i, (q, n) in enumerate(zip(p['P'], p['N'])):
            nv = Vector(n)
            start = Vector(q) + nv * 0.0015
            hit = 0.0
            tot = 0.0
            for d in dirs:
                dv = Vector(d)
                c = dv.dot(nv)
                if c <= 0:
                    dv = -dv
                    c = -c
                tot += c
                r = t.ray_cast(start, dv, 0.25)
                if r[0] is not None:
                    hit += c * (1.0 - min(r[3] / 0.25, 1.0) * 0.6)
            ao[i] = 1.0 - hit / max(tot, 1e-6)
        p['ao'] = ao


# ---------------------------------------------------------------- the writer


def pack(parts):
    P = np.concatenate([p['P'] for p in parts])
    N = np.concatenate([p['N'] for p in parts])
    idx = []
    off = 0
    for p in parts:
        idx.append(p['T'] + off)
        off += len(p['P'])
    T = np.concatenate(idx).astype(np.uint16 if off < 65536 else np.uint32)
    skin = np.concatenate([np.column_stack([p['a'], p['b'], np.round(np.clip(p['w'], 0, 1) * 255), np.round(np.clip(p['blush'], 0, 1) * 255)]) for p in parts]).astype(np.uint8)
    surf = np.concatenate([np.column_stack([p['code'], np.full(len(p['P']), p['variant']), np.round(np.clip(p['tail'], 0, 1) * 255), np.round(np.clip(p['ao'], 0, 1) * 255)]) for p in parts]).astype(np.uint8)
    nrm = np.zeros((len(N), 4), dtype=np.int8)
    nrm[:, :3] = np.round(np.clip(N, -1, 1) * 127).astype(np.int8)
    return P.astype(f32), nrm, skin, surf, T


def write_glb(path, meshes):
    """A GLB of one node per mesh, each one primitive with the compact layout in this file's header."""
    blob = bytearray()
    views = []
    accessors = []
    nodes = []
    gmeshes = []

    def add(data, target, count, ctype, typ, normalized=False, stride=None, minmax=None):
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        b = data.tobytes()
        blob.extend(b)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(b), 'target': target}
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
    for name, (P, nrm, skin, surf, T) in meshes.items():
        n = len(P)
        attrs = {
            'POSITION': add(P, 34962, n, 5126, 'VEC3', minmax=(P.min(0).tolist(), P.max(0).tolist())),
            'NORMAL': add(nrm, 34962, n, 5120, 'VEC3', normalized=True, stride=4),
            '_SKIN': add(skin, 34962, n, 5121, 'VEC4'),
            '_SURF': add(surf, 34962, n, 5121, 'VEC4'),
        }
        ind = add(T, 34963, T.size, 5123 if T.dtype == np.uint16 else 5125, 'SCALAR')
        gmeshes.append({'name': name, 'primitives': [{'attributes': attrs, 'indices': ind, 'mode': 4}]})
        nodes.append({'name': name, 'mesh': len(gmeshes) - 1})
    while len(blob) % 4:
        blob.append(0)
    doc = {
        'asset': {'version': '2.0', 'generator': 'Palimpsest tools/kits/figures.py'},
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


def main():
    out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'figures.glb'
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    made = build()
    meshes = {}
    for lod in ('hi', 'lo'):
        parts = level(made, lod)
        occlusion(parts, 40 if lod == 'hi' else 16)
        meshes[f'figure.{lod}'] = pack(parts)
        tris = {}
        for p in parts:
            tris[p['name']] = tris.get(p['name'], 0) + len(p['T'])
        print(f'figures: {lod} ' + ', '.join(f'{k} {v}' for k, v in tris.items()))
    size = write_glb(out, meshes)
    print(f'figures: {size} bytes -> {out}')


main()
