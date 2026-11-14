"""
The Palimpsest app mark, in three directions (Phase 5, Task 21), each built
from the wordmark's own materials (wordmark.py) and the app's scanned textures.

  a  The wordmark's P standing as a tower at dusk: sandstone root, brick floors
     with one left in primer, the bronze datum, glass with lit windows and a
     titanium crown, on a stepped ashlar plinth over paving, the city's own
     towers hazed on the horizon behind it.
  b  One tower, read bottom to top the way the city reads a repo: root, brick,
     datum, glass, crown and mast, seen from the street corner and cut by the
     icon's rounded square.
  c  The P carved into a granite face, the bronze datum inlaid across it and
     one window row lit inside the cut: the mark closest to a printed one.

  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python docs/brand/logo.py -- --direction a --out /tmp/logo-a-raw.png

Options after `--`: --direction a|b|c (default a), --out PATH, --samples N (256),
--size N (1648), --device gpu|cpu (gpu). Then docs/brand/icons.py masks the render to the macOS rounded
square and writes the icon set.
"""

import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default


DIRECTION = arg('--direction', 'a').lower()
OUT = os.path.abspath(arg('--out', os.path.join(HERE, f'logo-{DIRECTION}-raw.png')))
SAMPLES = int(arg('--samples', '256'))
SIZE = int(arg('--size', '1648'))
DEVICE = arg('--device', 'gpu').lower()
assert DIRECTION in ('a', 'b', 'c'), DIRECTION

# Build the wordmark's P (its materials, lights and world come with it). Direction a
# thickens the datum so it holds at 32 px and leaves the P's own brick floor in primer.
word_args = ['--word', 'P', '--variant', 'dark', '--build-only']
if DIRECTION == 'a':
    word_args += ['--datum', '0.04', '--scar-letter', 'P']
sys.argv = [sys.argv[0], '--'] + word_args
src = open(os.path.join(HERE, 'wordmark.py')).read()
g = {'__file__': os.path.join(HERE, 'wordmark.py'), '__name__': '__wordmark__'}
try:
    exec(compile(src, 'wordmark.py', 'exec'), g)
except SystemExit:
    pass

scene = bpy.context.scene
word = bpy.data.objects['Palimpsest']
CAP = g['CAP']
DATUM_TOP = g['DATUM_TOP']
materials = g['materials']
principled = g['principled']
tex_nodes = g['tex_nodes']
xmin, xmax, zmin, zmax = g['bounds'](word)
cx = (xmin + xmax) / 2
for v in word.data.vertices:
    v.co.x -= cx
xmin -= cx
xmax -= cx


# ------------------------------------------------------------------ helpers

def select_only(ob):
    for o in scene.objects:
        o.select_set(o == ob)
    bpy.context.view_layer.objects.active = ob


def box(name, size, loc, mat, bevel=0.0):
    """A solid block `size` (x, y, z) centred at `loc`, scale applied, optionally with softened edges."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = size
    ob.location = loc
    select_only(ob)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat is not None:
        ob.data.materials.append(mat)
    if bevel > 0:
        m = ob.modifiers.new('b', 'BEVEL')
        m.width = bevel
        m.segments = 2
        m.use_clamp_overlap = True
    return ob


def mat_textured(name, base, scale, value=1.0, saturation=1.0, roughness=None):
    """A scanned surface from app/public/textures, box projected."""
    m, nt, b = principled(name)
    diff, nm, sep = tex_nodes(nt, base, scale)
    hsv = nt.nodes.new('ShaderNodeHueSaturation')
    hsv.inputs['Saturation'].default_value = saturation
    hsv.inputs['Value'].default_value = value
    nt.links.new(diff.outputs['Color'], hsv.inputs['Color'])
    nt.links.new(hsv.outputs['Color'], b.inputs['Base Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if roughness is None:
        nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    else:
        b.inputs['Roughness'].default_value = roughness
    return m


HAZE = (0.36, 0.22, 0.24)  # the horizon's colour, which distance mixes into everything


def mat_far(name, tone, haze=0.6, lit=0.0, cells=(30.0, 30.0, 24.0), warmth=(1.0, 0.64, 0.34)):
    """A distant era: its tone sunk into the haze, with a scatter of lit windows if `lit` > 0."""
    m, nt, b = principled(name)
    n, l = nt.nodes, nt.links
    b.inputs['Base Color'].default_value = tuple(tone[i] * (1 - haze) + HAZE[i] * haze for i in range(3)) + (1,)
    b.inputs['Roughness'].default_value = 0.9
    b.inputs['Specular IOR Level'].default_value = 0.2
    if lit > 0:
        coord = n.new('ShaderNodeTexCoord')
        mp = n.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = cells
        l.new(coord.outputs['Object'], mp.inputs['Vector'])
        fl = n.new('ShaderNodeVectorMath')
        fl.operation = 'FLOOR'
        l.new(mp.outputs['Vector'], fl.inputs[0])
        noise = n.new('ShaderNodeTexWhiteNoise')
        noise.noise_dimensions = '3D'
        l.new(fl.outputs['Vector'], noise.inputs['Vector'])
        gt = n.new('ShaderNodeMath')
        gt.operation = 'GREATER_THAN'
        gt.inputs[1].default_value = 1.0 - lit
        l.new(noise.outputs['Value'], gt.inputs[0])
        st = n.new('ShaderNodeMath')
        st.operation = 'MULTIPLY'
        st.inputs[1].default_value = 1.4
        l.new(gt.outputs['Value'], st.inputs[0])
        l.new(st.outputs['Value'], b.inputs['Emission Strength'])
        b.inputs['Emission Color'].default_value = warmth + (1,)
    return m


FAR = {
    'stone': mat_far('far-stone', (0.40, 0.36, 0.30)),
    'brick': mat_far('far-brick', (0.32, 0.19, 0.14), lit=0.025, cells=(60.0, 60.0, 70.0)),
    'bronze': mat_far('far-bronze', (0.50, 0.30, 0.13), haze=0.4),
    'glass': mat_far('far-glass', (0.10, 0.12, 0.16), lit=0.10, cells=(90.0, 90.0, 80.0)),
    'titanium': mat_far('far-titanium', (0.36, 0.38, 0.42)),
}


def tower_tiers(x, y, w, d, h, rng, mats, proud_datum=0.03, base_z=0.0):
    """The city's tower: stone root, brick, the datum, a glass run set back, a stepped titanium crown.

    Eras are the wordmark's shares of the height; tall towers step back at 60% and 85%
    the way app/src/city/lots.ts masses offices."""
    out = []
    runs = [('stone', 0.0, 0.20, 1.0), ('brick', 0.20, 0.49, 0.985), ('bronze', 0.49, DATUM_TOP, 1.0 + proud_datum),
            ('glass', DATUM_TOP, 0.80, 0.92), ('titanium', 0.80, 1.0, 0.80)]
    tall = h > 0.55 * CAP
    for era, a, b_, k in runs:
        z0, z1 = base_z + a * h, base_z + b_ * h
        if era == 'titanium' and tall:
            steps = [(0.80, 0.90, 0.82), (0.90, 0.96, 0.68), (0.96, 1.0, 0.52)]
            for s0, s1, kk in steps:
                out.append(box('tier', (w * kk, d * kk, (s1 - s0) * h), (x, y, base_z + (s0 + s1) / 2 * h), mats[era]))
            continue
        out.append(box('tier', (w * k, d * k, z1 - z0), (x, y, (z0 + z1) / 2), mats[era]))
    return out


def skyline(rng, y0, y1, x0, x1, hmin, hmax, peak_x, base_z=0.0):
    """A band of the city's towers on the horizon, taller towards `peak_x`."""
    for row in range(3):
        y = y0 + (y1 - y0) * row / 2
        x = x0 + rng.uniform(0, 0.4)
        while x < x1:
            w = rng.uniform(0.16, 0.42)
            d = rng.uniform(0.2, 0.5)
            boost = 1.0 + 1.1 * math.exp(-((x - peak_x) ** 2) / 6.0)
            h = rng.uniform(hmin, hmax) * boost * (0.8 + 0.1 * row)
            tower_tiers(x + w / 2, y + rng.uniform(-0.3, 0.3), w, d, h, rng, FAR, base_z=base_z)
            x += w + rng.uniform(0.06, 0.5)


def camera(loc, target, half_height, portrait=1.0):
    cam = bpy.data.objects.get('cam')
    if cam is None:
        cd = bpy.data.cameras.new('cam')
        cam = bpy.data.objects.new('cam', cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = Vector(loc)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.sensor_fit = 'HORIZONTAL'
    cam.data.sensor_width = 36
    fov = 2 * math.atan(half_height / (cam.location - Vector(target)).length)
    cam.data.lens = 36 / (2 * math.tan(fov / 2))
    return cam


ground = next(o for o in scene.objects if o.name.startswith('Plane'))
ground.hide_render = False
ground.is_shadow_catcher = False
scene.render.film_transparent = False
bg = scene.world.node_tree.nodes['Background']

# ------------------------------------------------------------------ a: the P as a tower

if DIRECTION == 'a':
    bg.inputs['Strength'].default_value = 0.85
    scene.objects['rim'].data.energy *= 0.35

    # Paving under everything, and a stepped ashlar plinth with a stone kerb round its foot.
    ground.data.materials[0] = mat_textured('paving', 'pave', 1.6, value=0.55, saturation=0.7)
    ground.location.z = 0.0
    ashlar = mat_textured('ashlar', 'ashlar', 1.1, value=1.05, saturation=0.9)
    w = (xmax - xmin)
    course = 0.032
    steps = [(w * 1.30, 0.50), (w * 1.56, 0.66), (w * 1.86, 0.84)]
    for i, (sw, sd) in enumerate(reversed(steps)):
        box(f'course{i}', (sw, sd, course), (0, 0, course * (i + 0.5)), ashlar, bevel=0.003)
    top = course * len(steps)
    # A low kerb at the pavement's edge, and a bronze plate let into the top step where the datum is sworn.
    box('kerb', (w * 2.3, 0.05, 0.012), (0, -0.46, 0.006), materials['stone'], bevel=0.002)
    box('plate', (w * 0.28, 0.07, 0.003), (0, -0.19, top + 0.0015), materials['bronze'])
    word.location.z = top

    skyline(random.Random(11), 11.0, 19.0, -14.0, 14.0, 0.10 * CAP, 0.50 * CAP, peak_x=2.2)

    # Camera a little below the P's middle, looking up a shade, square frame.
    target = (0.02, 0, top + CAP * 0.46)
    camera((-0.34, -2.5, top + 0.12), target, CAP * 0.63)

# ------------------------------------------------------------------ b: one tower

elif DIRECTION == 'b':
    bg.inputs['Strength'].default_value = 0.85
    scene.objects['rim'].data.energy *= 0.5
    bpy.data.objects.remove(word)  # the P is not in this one

    ground.data.materials[0] = mat_textured('paving', 'pave', 1.6, value=0.55, saturation=0.7)
    ground.location.z = 0.0
    W = 0.26 * CAP
    H = 1.0 * CAP
    G = g['G']
    near = dict(materials)
    # Windows big enough to count at 32 px: six across the glass face, one row a floor.
    glass_w = W * 0.92
    near['glass'] = g['mat_glass'](0.12, 1.7, cols_per_unit=7.0 / glass_w, rows_per_unit=9.0 / ((0.80 - DATUM_TOP) * H), name='tower-glass')

    # Root: a taller ground floor and a second, with a stone cornice.
    box('root0', (W * 1.04, W * 1.04, 0.115 * H), (0, 0, 0.0575 * H), materials['stone'], bevel=0.003)
    box('root1', (W * 1.02, W * 1.02, 0.085 * H - G), (0, 0, (0.115 + 0.0425) * H), materials['stone'], bevel=0.003)
    box('cornice0', (W * 1.08, W * 1.08, 0.012 * H), (0, 0, 0.20 * H), materials['stone'], bevel=0.002)
    # The door: a dark bay in the front face with a bronze lintel.
    box('door', (W * 0.22, 0.02, 0.08 * H), (0, -W * 0.52 - 0.004, 0.04 * H), materials['core'])
    box('lintel', (W * 0.26, 0.012, 0.008 * H), (0, -W * 0.52 - 0.004, 0.082 * H), materials['bronze'])
    # Brick: four floors with reveals, the second left in primer.
    bh = (0.49 - 0.206) * H / 4
    for k in range(4):
        z0 = 0.206 * H + k * bh
        era = 'scar' if k == 1 else 'brick'
        box(f'brick{k}', (W, W, bh - G), (0, 0, z0 + (bh - G) / 2), materials[era], bevel=0.002)
    # The datum, proud of the brick.
    box('datum', (W * 1.05, W * 1.05, (DATUM_TOP - 0.49) * H), (0, 0, (0.49 + DATUM_TOP) / 2 * H), materials['bronze'], bevel=0.002)
    # Glass, set back, seven floors in one curtain wall; a titanium sill tops it.
    gz0, gz1 = DATUM_TOP * H, 0.80 * H
    box('glass', (glass_w, glass_w, gz1 - gz0), (0, 0, (gz0 + gz1) / 2), near['glass'])
    box('sill', (glass_w * 1.03, glass_w * 1.03, 0.008 * H), (0, 0, gz1), materials['titanium'], bevel=0.002)
    # Crown: three titanium steps and a mast.
    for s0, s1, kk in ((0.80, 0.90, 0.80), (0.90, 0.955, 0.64), (0.955, 1.0, 0.46)):
        box('crown', (W * kk, W * kk, (s1 - s0) * H - G), (0, 0, (s0 + s1) / 2 * H), materials['titanium'], bevel=0.002)
    bpy.ops.mesh.primitive_cylinder_add(radius=W * 0.028, depth=0.12 * H, vertices=24, location=(0, 0, 1.06 * H))
    mast = bpy.context.active_object
    mast.data.materials.append(materials['titanium'])
    # Two stone steps to the door.
    box('step0', (W * 0.5, 0.05, 0.012), (0, -W * 0.54 - 0.025, 0.006), materials['stone'], bevel=0.002)
    box('step1', (W * 0.4, 0.03, 0.012), (0, -W * 0.54 - 0.015, 0.018), materials['stone'], bevel=0.002)

    skyline(random.Random(5), 9.0, 16.0, -12.0, 12.0, 0.10 * CAP, 0.40 * CAP, peak_x=-1.6)

    # From the street corner, low, two faces showing; the tower runs from the frame's foot to near its top.
    target = (0.0, 0, H * 0.56)
    camera((-1.5, -2.6, H * 0.22), target, H * 0.66)

# ------------------------------------------------------------------ c: carved in stone

else:
    bpy.data.objects.remove(word)
    ground.hide_render = True
    scene.objects['rim'].hide_render = True
    scene.objects['fill'].data.energy *= 0.6
    # The sun comes from the upper left so the cut throws its shadow down and to the right.
    sun = scene.objects['sun']
    elev, azim = math.radians(42), math.radians(-56)
    d = Vector((math.sin(azim) * math.cos(elev), -math.cos(azim) * math.cos(elev), math.sin(elev)))
    sun.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    sun.data.energy = 5.5
    sun.data.color = (1.0, 0.78, 0.6)
    sun.data.angle = math.radians(2.5)

    face_stone = mat_textured('face-stone', 'sand', 1.3, value=1.2, saturation=0.72)
    cut_stone = mat_textured('cut-stone', 'sand', 1.3, value=0.42, saturation=0.6)
    face = box('face', (CAP * 2.4, 0.4, CAP * 2.4), (0, 0.2, CAP * 0.5), face_stone)

    # The cutter: the P at full height, sunk a tenth of its depth into the face, its edges chiselled.
    DEEP = 0.06
    cutter = g['text_mesh']('cutter', 0.0, body='P')
    cx2 = sum(g['bounds'](cutter)[:2]) / 2
    for v in cutter.data.vertices:
        v.co.x -= cx2
    g['slab'](cutter, -0.05, CAP * 1.05, bevel=0.0, depth=DEEP)
    cutter.data.materials.append(cut_stone)
    for v in cutter.data.vertices:
        v.co.y += 0.0  # spans y -DEEP..DEEP; the face is at y = 0, so the cut is DEEP deep
    bev = cutter.modifiers.new('chisel', 'BEVEL')
    bev.width = 0.006
    bev.segments = 1
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(40)
    bev.use_clamp_overlap = True
    select_only(cutter)
    bpy.ops.object.modifier_apply(modifier='chisel')
    cut = face.modifiers.new('carve', 'BOOLEAN')
    cut.operation = 'DIFFERENCE'
    cut.solver = 'EXACT'
    cut.object = cutter
    cut.material_mode = 'TRANSFER'
    select_only(face)
    bpy.ops.object.modifier_apply(modifier='carve')
    assert len(face.data.polygons) > 12, 'the carve left the face uncut'
    cutter.hide_render = True
    cutter.hide_viewport = True
    bpy.ops.object.shade_auto_smooth(angle=math.radians(35))

    # The bronze datum inlaid across the cut, proud of its floor and below the face.
    datum = g['text_mesh']('inlay', -0.003, body='P')
    for v in datum.data.vertices:
        v.co.x -= cx2
    g['slab'](datum, 0.49 * CAP, DATUM_TOP * CAP, bevel=0.0015, depth=0.012)
    for v in datum.data.vertices:
        v.co.y += DEEP - 0.012 + 0.0  # back on the recess floor, front 0.024 below the face
    datum.data.materials.append(materials['bronze'])

    # One row of lit windows inside the cut, at a glass floor. Find where the glyph is at that height.
    probe = g['text_mesh']('probe', 0.0, body='P')
    for v in probe.data.vertices:
        v.co.x -= cx2
    g['slab'](probe, -0.05, CAP * 1.05, bevel=0.0, depth=0.5)
    bpy.context.view_layer.update()
    zr = (DATUM_TOP + (0.80 - DATUM_TOP) * 0.5) * CAP
    px0, px1 = g['bounds'](probe)[:2]
    inside = []
    N = 600
    for i in range(N):
        x = px0 + (px1 - px0) * (i + 0.5) / N
        hit = probe.ray_cast(Vector((x, -1.0, zr)), Vector((0, 1, 0)))[0]
        inside.append(hit)
    segs = []
    start = None
    for i, h in enumerate(inside + [False]):
        if h and start is None:
            start = i
        if not h and start is not None:
            segs.append((px0 + (px1 - px0) * start / N, px0 + (px1 - px0) * i / N))
            start = None
    bpy.data.objects.remove(probe)
    lamp, lnt, lb = principled('window-light')
    lb.inputs['Base Color'].default_value = (0.02, 0.02, 0.02, 1)
    lb.inputs['Emission Color'].default_value = (1.0, 0.68, 0.40, 1)
    lb.inputs['Emission Strength'].default_value = 2.6
    frame_m = materials['core']
    pw, ph, pitch, margin = 0.014, 0.024, 0.021, 0.012
    for s0, s1 in segs:
        span = (s1 - s0) - 2 * margin
        n = max(1, int(span // pitch))
        left = (s0 + s1) / 2 - (n - 1) * pitch / 2
        for k in range(n):
            x = left + k * pitch
            box('frame', (pw + 0.006, 0.006, ph + 0.006), (x, DEEP - 0.003, zr), frame_m)
            box('pane', (pw, 0.004, ph), (x, DEEP - 0.006, zr), lamp)
    print('window row segments', segs)

    # Straight on, orthographic: the printed mark.
    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = Vector((0, -3.0, CAP * 0.5))
    cam.rotation_euler = (math.radians(90), 0, 0)
    cd.type = 'ORTHO'
    cd.ortho_scale = CAP * 1.42

# ------------------------------------------------------------------ render

scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
if DEVICE == 'gpu':
    try:
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for dev in prefs.devices:
            dev.use = True
        scene.cycles.device = 'GPU'
    except Exception as err:
        print('GPU unavailable:', err)
else:
    scene.cycles.device = 'CPU'
scene.cycles.use_denoising = True
scene.view_settings.view_transform = 'AgX'
try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except TypeError:
    pass
scene.render.image_settings.file_format = 'PNG'
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.cycles.samples = SAMPLES
scene.render.image_settings.color_mode = 'RGB'
scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print('wrote', OUT)
