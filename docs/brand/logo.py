"""
The Palimpsest app mark: the wordmark's P, standing alone as a tower at dusk.

It is the same P as in the wordmark (built by wordmark.py): sandstone root,
brick floors, the bronze datum band, glass with a few lit windows, and a
brushed titanium crown. Here it stands on a paved plinth under the dusk sky
the city is lit by, framed from a little below so it reads as a building.

  /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python docs/brand/logo.py -- --out /tmp/logo-raw.png

Then docs/brand/icons.py masks it to the macOS rounded square and writes the icon set.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[argv.index('--out') + 1]) if '--out' in argv else os.path.join(HERE, 'logo-raw.png')
SAMPLES = int(argv[argv.index('--samples') + 1]) if '--samples' in argv else 256
SIZE = int(argv[argv.index('--size') + 1]) if '--size' in argv else 1648

sys.argv = [sys.argv[0], '--', '--word', 'P', '--variant', 'dark', '--build-only']
src = open(os.path.join(HERE, 'wordmark.py')).read()
g = {'__file__': os.path.join(HERE, 'wordmark.py'), '__name__': '__wordmark__'}
try:
    exec(compile(src, 'wordmark.py', 'exec'), g)
except SystemExit:
    pass

scene = bpy.context.scene
word = bpy.data.objects['Palimpsest']
CAP = g['CAP']
xmin, xmax, zmin, zmax = g['bounds'](word)
cx = (xmin + xmax) / 2

# Centre the P on the origin.
for v in word.data.vertices:
    v.co.x -= cx

# The ground is visible here: a dark paving plinth the P stands on, and the street beyond.
ground = next(o for o in scene.objects if o.name.startswith('Plane'))
ground.location.z = -0.06
ground.hide_render = False
ground.is_shadow_catcher = False
gm = ground.data.materials[0]
gb = gm.node_tree.nodes['Principled BSDF']
gb.inputs['Base Color'].default_value = (0.03, 0.028, 0.03, 1)
gb.inputs['Roughness'].default_value = 0.55

bpy.ops.mesh.primitive_cube_add(size=1)
plinth = bpy.context.active_object
w = (xmax - xmin) * 1.35
plinth.scale = (w, 0.5, 0.03)
plinth.location = (0, 0, -0.015)
plinth.data.materials.append(g['materials']['stone'])
bev = plinth.modifiers.new('b', 'BEVEL')
bev.width = 0.004
bev.segments = 2
bpy.ops.mesh.primitive_cube_add(size=1)
step = bpy.context.active_object
step.scale = (w * 1.25, 0.68, 0.03)
step.location = (0, 0, -0.045)
step.data.materials.append(g['materials']['stone'])
sb2 = step.modifiers.new('b', 'BEVEL')
sb2.width = 0.004
sb2.segments = 2
word.location.z = 0.0
for o in (plinth, step):
    for oo in scene.objects:
        oo.select_set(oo == o)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


# The sky behind it is part of the mark: show the world to the camera.
scene.render.film_transparent = False
bg = scene.world.node_tree.nodes['Background']
bg.inputs['Strength'].default_value = 0.85
for name in ('rim',):
    scene.objects[name].data.energy *= 0.35

# A distant skyline low on the horizon, in silhouette, with a scatter of lit windows.
sil, snt, sb = g['principled']('skyline')
sb.inputs['Base Color'].default_value = (0.085, 0.06, 0.075, 1)
sb.inputs['Roughness'].default_value = 0.85
wn_ = snt.nodes
coord = wn_.new('ShaderNodeTexCoord')
mp = wn_.new('ShaderNodeMapping')
mp.inputs['Scale'].default_value = (34, 34, 26)
snt.links.new(coord.outputs['Object'], mp.inputs['Vector'])
vor = wn_.new('ShaderNodeTexWhiteNoise')
vor.noise_dimensions = '3D'
fl = wn_.new('ShaderNodeVectorMath')
fl.operation = 'FLOOR'
snt.links.new(mp.outputs['Vector'], fl.inputs[0])
snt.links.new(fl.outputs['Vector'], vor.inputs['Vector'])
gt = wn_.new('ShaderNodeMath')
gt.operation = 'GREATER_THAN'
gt.inputs[1].default_value = 0.955
snt.links.new(vor.outputs['Value'], gt.inputs[0])
snt.links.new(gt.outputs['Value'], sb.inputs['Emission Strength'])
sb.inputs['Emission Color'].default_value = (1.0, 0.62, 0.32, 1)
import random
rng = random.Random(11)
x = -9.0
while x < 9.0:
    wdt = rng.uniform(0.18, 0.5)
    h = rng.uniform(0.1, 0.42) * (1.0 + 0.9 * math.exp(-((x - 1.5) ** 2) / 4))
    bpy.ops.mesh.primitive_cube_add(size=1)
    t = bpy.context.active_object
    t.scale = (wdt, rng.uniform(0.3, 0.6), h)
    t.location = (x + wdt / 2, rng.uniform(16, 19), h / 2 - 0.06)
    t.data.materials.append(sil)
    x += wdt + rng.uniform(0.0, 0.12)

# Camera: a little below the P's middle, looking up, square frame.
cam = bpy.data.objects.get('cam')
if cam is None:
    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(cam)
scene.camera = cam
cam.data.lens = 50
cam.location = Vector((-0.3, -2.35, 0.08))
target = Vector((0.03, 0, CAP * 0.44))
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.sensor_fit = 'HORIZONTAL'
cam.data.sensor_width = 36
fov = 2 * math.atan((CAP * 0.76) / (cam.location - target).length)
cam.data.lens = 36 / (2 * math.tan(fov / 2))

scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for dev in prefs.devices:
        dev.use = True
    scene.cycles.device = 'GPU'
except Exception as err:
    print('GPU unavailable:', err)
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
