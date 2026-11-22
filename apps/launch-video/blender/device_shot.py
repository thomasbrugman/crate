import bpy, bmesh, math, sys, os
from mathutils import Vector
# Usage: blender -b -P device_shot.py -- <work-dir> [preview]
# <work-dir>/tex/laptop and <work-dir>/tex/phone hold 60 fps JPEG frames (0001.jpg, ...).
# Writes <work-dir>/scene.blend; render it with `blender -b <work-dir>/scene.blend -a`.
argv = sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
if not argv:
    sys.exit("usage: blender -b -P device_shot.py -- <work-dir> [preview]")
D = os.path.abspath(argv[0])
PREVIEW = "preview" in argv[1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
FPS, N = 60, 300
sc.render.fps = FPS; sc.frame_start = 1; sc.frame_end = N
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 16 if PREVIEW else 20
sc.cycles.use_adaptive_sampling = True
sc.cycles.adaptive_threshold = 0.02
sc.cycles.use_denoising = True
sc.render.use_persistent_data = True
sc.cycles.denoiser = 'OPENIMAGEDENOISE'
sc.cycles.max_bounces = 4; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 2; sc.cycles.transmission_bounces = 2
sc.cycles.caustics_reflective = False; sc.cycles.caustics_refractive = False
sc.render.resolution_x = 1920; sc.render.resolution_y = 1080
sc.render.resolution_percentage = 50 if PREVIEW else 100
sc.view_settings.view_transform = 'Standard'
sc.view_settings.look = 'None'
sc.render.image_settings.file_format = 'PNG'
sc.render.filepath = os.path.join(D, "out", "f_")

world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.004,0.004,0.005,1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0

def mat(name, color, metal=0.0, rough=0.4, coat=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color,1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    b.inputs["Coat Weight"].default_value = coat
    return m

def screen_mat(name, folder, nframes, strength):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    tex = nt.nodes.new("ShaderNodeTexImage")
    img = bpy.data.images.load(os.path.join(D,"tex",folder,"0001.jpg"))
    nframes = min(nframes, len(os.listdir(os.path.join(D,"tex",folder))))
    img.source = 'SEQUENCE'
    tex.image = img
    iu = tex.image_user; iu.frame_duration = nframes; iu.frame_start = 1; iu.frame_offset = 0; iu.use_auto_refresh = True; iu.use_cyclic = False
    tex.extension = 'CLIP'
    em = nt.nodes.new("ShaderNodeEmission"); em.inputs[1].default_value = strength
    nt.links.new(tex.outputs[0], em.inputs[0])
    gl = nt.nodes.new("ShaderNodeBsdfGlossy"); gl.inputs[1].default_value = 0.04
    lw = nt.nodes.new("ShaderNodeLayerWeight"); lw.inputs[0].default_value = 0.08
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(lw.outputs["Fresnel"], mix.inputs[0])
    nt.links.new(em.outputs[0], mix.inputs[1]); nt.links.new(gl.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    return m

def rounded_rect(name, w, h, r, z=0.0, segs=12):
    bm = bmesh.new()
    pts=[]
    for cx,cy,a0 in [(w/2-r,h/2-r,0),(-w/2+r,h/2-r,90),(-w/2+r,-h/2+r,180),(w/2-r,-h/2+r,270)]:
        for i in range(segs+1):
            a = math.radians(a0+90*i/segs); pts.append((cx+r*math.cos(a), cy+r*math.sin(a), z))
    vs=[bm.verts.new(p) for p in pts]; f=bm.faces.new(vs)
    uv = bm.loops.layers.uv.new()
    for l in f.loops:
        l[uv].uv = (l.vert.co.x/w+0.5, l.vert.co.y/h+0.5)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); sc.collection.objects.link(ob); return ob

def slab(name, w, h, t, r, m, bevel=0.01):
    ob = rounded_rect(name, w, h, r)
    me = ob.data; bm = bmesh.new(); bm.from_mesh(me)
    ret = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    for v in [e for e in ret["geom"] if isinstance(e,bmesh.types.BMVert)]: v.co.z += t
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me); bm.free()
    md = ob.modifiers.new("b","BEVEL"); md.width = bevel; md.segments = 4; md.limit_method='ANGLE'
    ob.data.materials.append(m)
    for p in ob.data.polygons: p.use_smooth = True
    ob.modifiers.new("ws","WEIGHTED_NORMAL")
    return ob

alu = mat("alu",(0.42,0.43,0.45),metal=1.0,rough=0.28)
alu_dark = mat("alu_dark",(0.06,0.06,0.065),metal=0.6,rough=0.45)
black = mat("glass_black",(0.003,0.003,0.003),rough=0.08,coat=1.0)
keymat = mat("keys",(0.012,0.012,0.013),rough=0.55)
phone_body = mat("phone_body",(0.08,0.08,0.085),metal=1.0,rough=0.22)

# Laptop (base 3.0 x 2.1), hinge at y=+1.05
root = bpy.data.objects.new("laptop", None); sc.collection.objects.link(root)
base = slab("base",3.0,2.1,0.07,0.12,alu,0.02); base.parent = root
kb = rounded_rect("keywell",2.6,1.0,0.04,z=0.0705); kb.location.y = 0.38; kb.data.materials.append(alu_dark); kb.parent = root
key = slab("key",0.16,0.16,0.012,0.025,keymat,0.004); key.location = (-1.24,-0.05,0.066); key.parent = root
a = key.modifiers.new("ax","ARRAY"); a.count=14; a.relative_offset_displace=(1.1,0,0)
a2 = key.modifiers.new("ay","ARRAY"); a2.count=5; a2.relative_offset_displace=(0,1.1,0)
key.location.y = 0.0
tp = rounded_rect("trackpad",1.15,0.68,0.05,z=0.0708); tp.location.y = -0.55; tp.data.materials.append(mat("tp",(0.36,0.37,0.39),metal=1.0,rough=0.18)); tp.parent = root
hinge = bpy.data.objects.new("hinge", None); sc.collection.objects.link(hinge); hinge.parent = root
hinge.location = (0,1.03,0.07); hinge.rotation_euler.x = math.radians(-15)
lid = slab("lid",3.0,1.98,0.045,0.12,alu,0.015); lid.parent = hinge
lid.rotation_euler.x = math.radians(90); lid.location = (0,0.045,0.99)
bez = rounded_rect("bezel",2.94,1.92,0.1); bez.data.materials.append(black); bez.parent = lid; bez.location.z = 0.0465
scr = rounded_rect("lap_screen",2.80,2.80*810/1440,0.02); scr.data.materials.append(screen_mat("lap_scr","laptop",360,1.25)); scr.parent = lid
scr.location = (0,0.04,0.048)
# flip UV v because of 180 rotation about x

# Phone 0.72 x 1.48, standing, right-front
proot = bpy.data.objects.new("phone", None); sc.collection.objects.link(proot)
proot.location = (2.35,-0.75,0.82); proot.rotation_euler = (math.radians(82),0,math.radians(-28))
pb = slab("pbody",0.74,1.52,0.075,0.12,phone_body,0.03); pb.parent = proot; pb.location.z = -0.0375
pf = rounded_rect("pfront",0.725,1.505,0.11,z=0.0385); pf.data.materials.append(black); pf.parent = proot
ps = rounded_rect("pscreen",0.68,0.68*2622/1206,0.095,z=0.0392); ps.data.materials.append(screen_mat("ph_scr","phone",243,1.0)); ps.parent = proot

# Floor
bpy.ops.mesh.primitive_plane_add(size=60); fl = bpy.context.object
fl.data.materials.append(mat("floor",(0.012,0.012,0.014),rough=0.32))

# Lights
def area(name, loc, rot, size, energy, color=(1,1,1), shape='RECTANGLE', sy=None):
    l = bpy.data.lights.new(name,'AREA'); l.energy = energy; l.color = color; l.shape = shape; l.size = size; l.size_y = sy or size
    o = bpy.data.objects.new(name,l); sc.collection.objects.link(o); o.location = loc; o.rotation_euler = [math.radians(r) for r in rot]; return o
area("key",(-4,-3,5),(45,0,-50),4,900)
area("rim",(2,6,3.5),(-65,0,180),6,700,(0.75,0.85,1.0),sy=1.2)
area("fill",(5,-4,1.5),(75,0,55),3,120,(1.0,0.93,0.85))
area("top",(0,0,7),(0,0,0),3,250)

# Camera: slow arc + push in, ease in/out
cam_d = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam",cam_d); sc.collection.objects.link(cam); sc.camera = cam
cam_d.lens = 45; cam_d.dof.use_dof = True; cam_d.dof.aperture_fstop = 4.0; cam_d.sensor_width = 36
tgt = bpy.data.objects.new("tgt",None); sc.collection.objects.link(tgt)
cam_d.dof.focus_object = tgt
c = cam.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis='TRACK_NEGATIVE_Z'; c.up_axis='UP_Y'
keys = [(1,(-5.8,-5.4,0.45),(0.3,0.7,0.85),30),(N,(1.7,-5.5,1.75),(0.85,0.7,0.95),40)]
for f,loc,t,lens in keys:
    cam.location = loc; cam.keyframe_insert("location",frame=f)
    tgt.location = t; tgt.keyframe_insert("location",frame=f)
    cam_d.lens = lens; cam_d.keyframe_insert("lens",frame=f)
for o in (cam, tgt, cam_d):
    ad = o.animation_data
    for fc in ad.action.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation='BEZIER'; kp.easing='AUTO'; kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
# Phone gentle turn
proot.keyframe_insert("rotation_euler",frame=1)
proot.rotation_euler.z = math.radians(-16); proot.keyframe_insert("rotation_euler",frame=N)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(D,"scene.blend"))
