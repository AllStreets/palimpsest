"""
The Palimpsest wordmark, built like the towers.

Every letter is cut into floors and read bottom to top, the way a tower is:
a sandstone root, brick floors, a bronze datum band where the repo joined the
city, then glass floors with a few lit windows and a brushed titanium crown.
Each era steps back a little from the one below it, so the letters taper the
way the towers do. One brick floor of the M is left in primer: a scar.

Run headless:

  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python docs/brand/wordmark.py -- --variant dark --out docs/brand/wordmark-dark-raw.png

Options after `--`:
  --variant dark|light   dusk with lit windows, or the same letters lit for a white page
  --out PATH             PNG with alpha
  --samples N            Cycles samples (default 192)
  --width N              render width in pixels (default 2600)
  --font PATH            letter font (default docs/brand/fonts/Cinzel-800.ttf)
  --save-blend PATH      also save the .blend for inspection

Textures are the Poly Haven scans the app already ships (app/public/textures, CC0).
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
TEX = os.path.join(REPO, 'app', 'public', 'textures')


def arg(name, default):
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if name in argv:
        return argv[argv.index(name) + 1]
    return default


VARIANT = arg('--variant', 'dark')
OUT = os.path.abspath(arg('--out', os.path.join(HERE, f'wordmark-{VARIANT}-raw.png')))
SAMPLES = int(arg('--samples', '192'))
WIDTH = int(arg('--width', '2600'))
FONT = os.path.abspath(arg('--font', os.path.join(HERE, 'fonts', 'Cinzel-800.ttf')))
SAVE_BLEND = arg('--save-blend', '')
WORD = arg('--word', 'PALIMPSEST')
BUILD_ONLY = '--build-only' in sys.argv

# Letter proportions: Roman capitals drawn taller than the font, like shafts.
STRETCH = 1.32
DEPTH = 0.085         # half the extrusion, in font units (size 1)
TRACKING = 1.16       # letter spacing multiplier

# ------------------------------------------------------------------ scene

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
font = bpy.data.fonts.load(FONT)


def text_mesh(name, offset, bevel=0.0, body=WORD):
    """The text as a flat filled glyph standing upright in the xz plane on z = 0, its outline grown (or shrunk) by `offset`."""
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    cu.font = font
    cu.size = 1.0
    cu.space_character = TRACKING
    cu.align_x = 'CENTER'
    cu.extrude = 0.0
    cu.offset = offset
    cu.bevel_depth = bevel
    cu.bevel_resolution = 2
    cu.resolution_u = 24
    ob = bpy.data.objects.new(name, cu)
    scene.collection.objects.link(ob)
    ob.rotation_euler = (math.radians(90), 0, 0)
    ob.scale = (1, STRETCH, 1)
    bpy.context.view_layer.objects.active = ob
    for o in scene.objects:
        o.select_set(o == ob)
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # Blender builds text as loose strips (faces, walls, bevels); weld them into closed solids.
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def bounds(ob):
    xs = [v.co.x for v in ob.data.vertices]
    zs = [v.co.z for v in ob.data.vertices]
    return min(xs), max(xs), min(zs), max(zs)


def slab(ob, z0, z1, bevel=0.0032, depth=None):
    """Cut the flat glyph to the band z0..z1, then extrude it into a solid floor slab with softened edges."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    for co, no in (((0, 0, z1), (0, 0, 1)), ((0, 0, z0), (0, 0, -1))):
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no, clear_outer=True)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-6, edges=bm.edges)
    depth = DEPTH if depth is None else depth
    for v in bm.verts:
        v.co.y = -depth
    res = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:], use_keep_orig=True)
    verts = [g for g in res['geom'] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=verts, vec=(0, 2 * depth, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    if bevel > 0:
        mod = ob.modifiers.new('soft', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(40)
        mod.use_clamp_overlap = True
        mod.harden_normals = False
        bpy.context.view_layer.objects.active = ob
        for o in scene.objects:
            o.select_set(o == ob)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return ob


# Cap height: measure an H.
probe = text_mesh('probe', 0.0, body='H')
CAP = bounds(probe)[3]
bpy.data.objects.remove(probe)

# ------------------------------------------------------------------ floors

# (name, top as a share of cap height, era, outline offset, floors in the run)
# Each era steps back from the one below it. The datum band sits between brick and glass.
G = 0.0055 * CAP  # reveal between floors
RUNS = [
    # name, top, era, width scale, depth scale, floors
    ('root', 0.20, 'stone', 1.0, 1.14, 2),
    ('brick', 0.49, 'brick', 0.994, 1.0, 4),
    ('datum', 0.512, 'bronze', 1.026, 1.24, 1),
    ('glass', 0.80, 'glass', 0.984, 0.9, 5),
    ('crown', 1.00, 'titanium', 0.968, 0.8, 3),
]

materials = {}


def img(name, colorspace='sRGB'):
    path = os.path.join(TEX, name)
    im = bpy.data.images.load(path, check_existing=True)
    im.colorspace_settings.name = colorspace
    return im


def tex_nodes(nt, base, scale):
    """Box-projected scan texture set: colour, normal, and AO/roughness/metal packed."""
    n = nt.nodes
    l = nt.links
    coord = n.new('ShaderNodeTexCoord')
    mapping = n.new('ShaderNodeMapping')
    mapping.inputs['Scale'].default_value = (scale, scale, scale)
    l.new(coord.outputs['Object'], mapping.inputs['Vector'])
    out = {}
    for key, cs in (('diff', 'sRGB'), ('nor', 'Non-Color'), ('arm', 'Non-Color')):
        t = n.new('ShaderNodeTexImage')
        t.image = img(f'{base}_{key}.jpg', cs)
        t.projection = 'BOX'
        t.projection_blend = 0.25
        l.new(mapping.outputs['Vector'], t.inputs['Vector'])
        out[key] = t
    nm = n.new('ShaderNodeNormalMap')
    nm.inputs['Strength'].default_value = 1.0
    l.new(out['nor'].outputs['Color'], nm.inputs['Color'])
    sep = n.new('ShaderNodeSeparateColor')
    l.new(out['arm'].outputs['Color'], sep.inputs['Color'])
    return out['diff'], nm, sep


def principled(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    return m, nt, bsdf


def mat_stone():
    m, nt, b = principled('stone')
    diff, nm, sep = tex_nodes(nt, 'sand', 2.2)
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = 0.85
    hsv.inputs['Value'].default_value = 1.15
    nt.links.new(diff.outputs['Color'], hsv.inputs['Color'])
    nt.links.new(hsv.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    return m


def mat_brick():
    m, nt, b = principled('brick')
    diff, nm, sep = tex_nodes(nt, 'brick', 4.5)
    nt.links.new(diff.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    return m


def mat_scar():
    m, nt, b = principled('scar')
    diff, nm, sep = tex_nodes(nt, 'rust', 3.0)
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = 0.8
    hsv.inputs['Value'].default_value = 0.7
    hsv.inputs['Hue'].default_value = 0.49
    nt.links.new(diff.outputs['Color'], hsv.inputs['Color'])
    nt.links.new(hsv.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    return m


def mat_bronze():
    m, nt, b = principled('bronze')
    b.inputs['Base Color'].default_value = (0.62, 0.38, 0.17, 1)
    b.inputs['Metallic'].default_value = 1.0
    b.inputs['Roughness'].default_value = 0.2
    return m


def mat_titanium():
    """Brushed titanium cladding: fine horizontal grain, a faint panel seam every few windows, cool silver."""
    m, nt, b = principled('titanium')
    n = nt.nodes
    l = nt.links
    coord = n.new('ShaderNodeTexCoord')
    grain_map = n.new('ShaderNodeMapping')
    grain_map.inputs['Scale'].default_value = (3.0, 3.0, 260.0)
    l.new(coord.outputs['Object'], grain_map.inputs['Vector'])
    grain = n.new('ShaderNodeTexNoise')
    grain.inputs['Scale'].default_value = 6.0
    grain.inputs['Detail'].default_value = 8.0
    l.new(grain_map.outputs['Vector'], grain.inputs['Vector'])
    rough = n.new('ShaderNodeMapRange')
    rough.inputs['To Min'].default_value = 0.34
    rough.inputs['To Max'].default_value = 0.5
    l.new(grain.outputs['Fac'], rough.inputs['Value'])
    l.new(rough.outputs['Result'], b.inputs['Roughness'])
    tint = n.new('ShaderNodeMix')
    tint.data_type = 'RGBA'
    l.new(grain.outputs['Fac'], tint.inputs['Factor'])
    tint.inputs['A'].default_value = (0.56, 0.6, 0.66, 1)
    tint.inputs['B'].default_value = (0.68, 0.71, 0.76, 1)
    l.new(tint.outputs['Result'], b.inputs['Base Color'])
    b.inputs['Metallic'].default_value = 1.0
    if 'Anisotropic' in b.inputs:
        b.inputs['Anisotropic'].default_value = 0.6
    bump = n.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.08
    l.new(grain.outputs['Fac'], bump.inputs['Height'])
    l.new(bump.outputs['Normal'], b.inputs['Normal'])
    return m


def mat_glass(lit_share, window_strength):
    """Curtain wall: dark reflective glass in a mullion grid, with some windows lit warm."""
    m, nt, b = principled('glass')
    n = nt.nodes
    l = nt.links
    coord = n.new('ShaderNodeTexCoord')
    sep = n.new('ShaderNodeSeparateXYZ')
    l.new(coord.outputs['Object'], sep.inputs['Vector'])
    # Horizontal position along any face: x on the fronts, y on the sides.
    along = n.new('ShaderNodeMath')
    along.operation = 'ADD'
    l.new(sep.outputs['X'], along.inputs[0])
    l.new(sep.outputs['Y'], along.inputs[1])
    cols = n.new('ShaderNodeMath')
    cols.operation = 'MULTIPLY'
    cols.inputs[1].default_value = 128.0
    l.new(along.outputs['Value'], cols.inputs[0])
    rows = n.new('ShaderNodeMath')
    rows.operation = 'MULTIPLY'
    rows.inputs[1].default_value = 5.0 / ((0.80 - 0.512) * CAP)  # one row per floor
    l.new(sep.outputs['Z'], rows.inputs[0])
    # Cell ids and fractions.
    def floor_of(sock):
        f = n.new('ShaderNodeMath')
        f.operation = 'FLOOR'
        l.new(sock, f.inputs[0])
        return f

    def frac_of(sock):
        f = n.new('ShaderNodeMath')
        f.operation = 'FRACT'
        l.new(sock, f.inputs[0])
        return f

    cx, cz = floor_of(cols.outputs['Value']), floor_of(rows.outputs['Value'])
    fx, fz = frac_of(cols.outputs['Value']), frac_of(rows.outputs['Value'])
    comb = n.new('ShaderNodeCombineXYZ')
    l.new(cx.outputs['Value'], comb.inputs['X'])
    l.new(cz.outputs['Value'], comb.inputs['Y'])
    noise = n.new('ShaderNodeTexWhiteNoise')
    noise.noise_dimensions = '3D'
    l.new(comb.outputs['Vector'], noise.inputs['Vector'])
    lit = n.new('ShaderNodeMath')
    lit.operation = 'LESS_THAN'
    lit.inputs[1].default_value = lit_share
    l.new(noise.outputs['Value'], lit.inputs[0])
    # Mullions: thin frame around each cell.
    def band(sock, lo, hi):
        a = n.new('ShaderNodeMath')
        a.operation = 'GREATER_THAN'
        a.inputs[1].default_value = lo
        l.new(sock, a.inputs[0])
        c = n.new('ShaderNodeMath')
        c.operation = 'LESS_THAN'
        c.inputs[1].default_value = hi
        l.new(sock, c.inputs[0])
        mm = n.new('ShaderNodeMath')
        mm.operation = 'MULTIPLY'
        l.new(a.outputs['Value'], mm.inputs[0])
        l.new(c.outputs['Value'], mm.inputs[1])
        return mm

    pane_x = band(fx.outputs['Value'], 0.09, 0.91)
    pane_z = band(fz.outputs['Value'], 0.16, 0.86)
    pane = n.new('ShaderNodeMath')
    pane.operation = 'MULTIPLY'
    l.new(pane_x.outputs['Value'], pane.inputs[0])
    l.new(pane_z.outputs['Value'], pane.inputs[1])
    # Variation in warmth and brightness per lit window.
    warm = n.new('ShaderNodeValToRGB')
    warm.color_ramp.elements[0].color = (1.0, 0.55, 0.24, 1)
    warm.color_ramp.elements[1].color = (1.0, 0.78, 0.52, 1)
    noise2 = n.new('ShaderNodeTexWhiteNoise')
    noise2.noise_dimensions = '3D'
    off = n.new('ShaderNodeVectorMath')
    off.operation = 'ADD'
    off.inputs[1].default_value = (17.3, 5.1, 0)
    l.new(comb.outputs['Vector'], off.inputs[0])
    l.new(off.outputs['Vector'], noise2.inputs['Vector'])
    l.new(noise2.outputs['Value'], warm.inputs['Fac'])
    on = n.new('ShaderNodeMath')
    on.operation = 'MULTIPLY'
    l.new(lit.outputs['Value'], on.inputs[0])
    l.new(pane.outputs['Value'], on.inputs[1])
    strength = n.new('ShaderNodeMath')
    strength.operation = 'MULTIPLY'
    strength.inputs[1].default_value = window_strength
    l.new(on.outputs['Value'], strength.inputs[0])
    l.new(warm.outputs['Color'], b.inputs['Emission Color'])
    l.new(strength.outputs['Value'], b.inputs['Emission Strength'])
    # Glass in the panes, dark anodised frame on the mullions.
    col = n.new('ShaderNodeMix')
    col.data_type = 'RGBA'
    l.new(pane.outputs['Value'], col.inputs['Factor'])
    col.inputs['A'].default_value = (0.05, 0.05, 0.055, 1)
    col.inputs['B'].default_value = (0.018, 0.026, 0.036, 1)
    l.new(col.outputs['Result'], b.inputs['Base Color'])
    rgh = n.new('ShaderNodeMapRange')
    rgh.inputs['To Min'].default_value = 0.35
    rgh.inputs['To Max'].default_value = 0.03
    l.new(pane.outputs['Value'], rgh.inputs['Value'])
    l.new(rgh.outputs['Result'], b.inputs['Roughness'])
    met = n.new('ShaderNodeMapRange')
    met.inputs['To Min'].default_value = 0.9
    met.inputs['To Max'].default_value = 0.0
    l.new(pane.outputs['Value'], met.inputs['Value'])
    l.new(met.outputs['Result'], b.inputs['Metallic'])
    b.inputs['Specular IOR Level'].default_value = 0.7
    # Recess the panes a hair behind the mullions.
    bump = n.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.35
    bump.inputs['Distance'].default_value = 0.002
    l.new(pane.outputs['Value'], bump.inputs['Height'])
    l.new(bump.outputs['Normal'], b.inputs['Normal'])
    return m


def mat_core():
    m, nt, b = principled('core')
    b.inputs['Base Color'].default_value = (0.02, 0.018, 0.016, 1)
    b.inputs['Roughness'].default_value = 0.8
    return m


materials['stone'] = mat_stone()
materials['brick'] = mat_brick()
materials['scar'] = mat_scar()
materials['bronze'] = mat_bronze()
materials['titanium'] = mat_titanium()
materials['glass'] = mat_glass(0.13 if VARIANT == 'dark' else 0.09, 1.9 if VARIANT == 'dark' else 1.1)
materials['core'] = mat_core()
MAT_ORDER = ['core', 'stone', 'brick', 'scar', 'bronze', 'glass', 'titanium']

# ------------------------------------------------------------------ build

def split_loose(ob):
    bpy.context.view_layer.objects.active = ob
    for o in scene.objects:
        o.select_set(o == ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='LOOSE')
    bpy.ops.object.mode_set(mode='OBJECT')
    parts = [o for o in scene.objects if o.select_get()]
    parts.sort(key=lambda o: min(v.co.x for v in o.data.vertices))
    return parts


# Where each letter stands: the left edge of each glyph in the set word.
_ref = split_loose(text_mesh('ref', 0.0, bevel=0.0))
assert len(_ref) == len(WORD), f'reference word split into {len(_ref)} parts'
LEFT = [min(v.co.x for v in o.data.vertices) for o in _ref]
for o in _ref:
    bpy.data.objects.remove(o)
_own_left = {}
for ch in set(WORD):
    o = text_mesh('own', 0.0, bevel=0.0, body=ch)
    _own_left[ch] = min(v.co.x for v in o.data.vertices)
    bpy.data.objects.remove(o)


def letters(name, width=1.0):
    """The word, one object per letter, each letter narrowed about its own centre by `width` (a setback)."""
    out = []
    for i, ch in enumerate(WORD):
        o = text_mesh(f'{name}-{i}', 0.0, body=ch)
        dx = LEFT[i] - _own_left[ch]
        xs = [v.co.x for v in o.data.vertices]
        mid = (min(xs) + max(xs)) / 2
        for v in o.data.vertices:
            v.co.x = mid + (v.co.x - mid) * width + dx
        out.append(o)
    return out


pieces = []
for core in letters('core', 0.93):
    slab(core, 0.0, CAP * 0.995, bevel=0.0, depth=DEPTH * 0.68)
    core.data.materials.append(materials['core'])
    pieces.append(core)

SCAR_FLOOR = ('brick', 2)

lo = 0.0
for name, top, era, width, deep, count in RUNS:
    hi = top * CAP
    h = (hi - lo) / count
    for k in range(count):
        z0 = lo + k * h + (G if lo + k * h > 0 else 0.0)
        z1 = lo + (k + 1) * h
        if name == 'datum':
            z0, z1 = lo + 0.0015 * CAP, hi - 0.0015 * CAP
        for i, ob in enumerate(letters(f'{name}{k}', width)):
            slab(ob, z0, z1, depth=DEPTH * deep)
            scar = (name, k) == SCAR_FLOOR and WORD[i] == 'M'
            ob.data.materials.append(materials['scar' if scar else era])
            pieces.append(ob)
    lo = hi

# Join everything into one object.
for o in scene.objects:
    o.select_set(o in pieces)
bpy.context.view_layer.objects.active = pieces[0]
bpy.ops.object.join()
word = bpy.context.active_object
word.name = 'Palimpsest'
bpy.ops.object.shade_auto_smooth(angle=math.radians(35))
xmin, xmax, zmin, zmax = bounds(word)
print(f'word spans x {xmin:.3f}..{xmax:.3f}, height {zmax:.3f}')

# ------------------------------------------------------------------ ground, light, world

bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
ground = bpy.context.active_object
ground.is_shadow_catcher = VARIANT == 'light'
ground.hide_render = VARIANT != 'light'
gm, gnt, gb = principled('ground')
gb.inputs['Base Color'].default_value = (0.05, 0.05, 0.05, 1)
gb.inputs['Roughness'].default_value = 0.6
ground.data.materials.append(gm)

world = bpy.data.worlds.new('dusk')
scene.world = world
world.use_nodes = True
wn = world.node_tree.nodes
wl = world.node_tree.links
bg = wn['Background']
coord = wn.new('ShaderNodeTexCoord')
sepw = wn.new('ShaderNodeSeparateXYZ')
wl.new(coord.outputs['Generated'], sepw.inputs['Vector'])
ramp = wn.new('ShaderNodeValToRGB')
cr = ramp.color_ramp
cr.elements[0].position = 0.44
cr.elements[0].color = (0.05, 0.035, 0.03, 1)        # ground bounce below the horizon
cr.elements[1].position = 1.0
cr.elements[1].color = (0.018, 0.028, 0.075, 1)      # zenith
e = cr.elements.new(0.505)
e.color = (0.95, 0.42, 0.2, 1)                      # horizon glow
e2 = cr.elements.new(0.62)
e2.color = (0.32, 0.2, 0.3, 1)                      # mauve band above it
to01 = wn.new('ShaderNodeMapRange')
to01.inputs['From Min'].default_value = -1.0
to01.inputs['From Max'].default_value = 1.0
wl.new(sepw.outputs['Z'], to01.inputs['Value'])
wl.new(to01.outputs['Result'], ramp.inputs['Fac'])
wl.new(ramp.outputs['Color'], bg.inputs['Color'])
bg.inputs['Strength'].default_value = 0.55 if VARIANT == 'dark' else 1.1

# Low sun from the front left, warm.
sun_data = bpy.data.lights.new('sun', 'SUN')
sun_data.energy = 4.2 if VARIANT == 'dark' else 5.0
sun_data.color = (1.0, 0.6, 0.36)
sun_data.angle = math.radians(1.2)
sun = bpy.data.objects.new('sun', sun_data)
scene.collection.objects.link(sun)
elev, azim = math.radians(9), math.radians(-52)
d = Vector((math.sin(azim) * math.cos(elev), -math.cos(azim) * math.cos(elev), math.sin(elev)))
sun.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()

# Cool sky fill from high right, and a warm rim from behind to separate edges from a dark page.
def area(name, loc, energy, color, size):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = energy
    ld.color = color
    ld.size = size
    o = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector((0, 0, CAP * 0.5)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o

area('fill', (6, -9, 7), 260 if VARIANT == 'dark' else 520, (0.55, 0.65, 1.0), 8)
area('rim', (-3, 8, 3.5), 380, (1.0, 0.62, 0.4), 6)
# The sunset behind the camera, as the metal sees it: a long warm card low on the horizon.
card = area('sunset', (-1.5, -16, 1.2), 700 if VARIANT == 'dark' else 1100, (1.0, 0.7, 0.52), 1)
card.data.shape = 'RECTANGLE'
card.data.size = 18
card.data.size_y = 2.5
card.visible_camera = False

if BUILD_ONLY:
    raise SystemExit  # logo.py takes over from here

# ------------------------------------------------------------------ camera

cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 85
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
span = xmax - xmin
target = Vector(((xmin + xmax) / 2, 0, CAP * 0.5))
cam.location = Vector((target.x - span * 0.14, -span * 2.4, CAP * 0.12))
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam_data.dof.use_dof = False

aspect = 3.7
scene.render.resolution_x = WIDTH
scene.render.resolution_y = int(WIDTH / aspect)
cam_data.sensor_fit = 'HORIZONTAL'
# Fit the word with a margin.
cam_data.sensor_width = 36
fov_needed = 2 * math.atan((span * 0.56) / (cam.location - target).length)
cam_data.lens = 36 / (2 * math.tan(fov_needed / 2))

# ------------------------------------------------------------------ render

scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    scene.cycles.device = 'GPU'
except Exception as err:  # CPU is fine, just slower
    print('GPU unavailable:', err)
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.view_settings.view_transform = 'AgX'
try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except TypeError:
    pass
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.color_depth = '16'
scene.render.filepath = OUT
if SAVE_BLEND:
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(SAVE_BLEND))
bpy.ops.render.render(write_still=True)
print('wrote', OUT)
