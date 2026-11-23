"""Render independent device shots with Blender 4.2 LTS."""
import bpy, sys, os, json, time, math
from pathlib import Path
from mathutils import Vector
from mathutils.geometry import barycentric_transform
from bpy_extras.object_utils import world_to_camera_view

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROW_UVS, can_resume_frame, render_options, work_parser
from device_shot import build_scene

parser = work_parser(__doc__)
render_options(parser)
parser.add_argument('--mode', choices=('boards', 'animatic', 'benchmark', 'final', 'anchors'), default='boards')
parser.add_argument('--shot', type=int, choices=range(1, 7))
args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
D = args.work_dir
MODE = args.mode
selected = args.shot - 1 if args.shot else None
LAPTOP_FINISH = args.finish
scene = build_scene(D, args.laptop_model or D/'models/macbook-neo-ranguel/model.glb',
                    args.laptop_screen, args.phone_model or D/'models/iphone-15-pro-max-polyman/model.glb',
                    args.phone_screen, args.lid_tilt)
sc, cam, cam_d, tgt, proot = scene.sc, scene.cam, scene.cam_d, scene.tgt, scene.proot
lap_objects, lap_screen, phone_objects = scene.lap_objects, scene.lap_screen, scene.phone_objects
def surface(name, color, metal, rough):
    material = bpy.data.materials.get(name)
    if material is None:
        return
    node = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    for socket, value in [('Base Color', (*color, 1)), ('Metallic', metal),
                          ('Roughness', rough), ('Emission Strength', 0), ('Coat Weight', 0)]:
        for link in list(node.inputs[socket].links):
            material.node_tree.links.remove(link)
        node.inputs[socket].default_value = value

if LAPTOP_FINISH == 'silver':
    for name in ('Anodized_aluminum', 'Touchpad_tint', 'Touchpad_glass', 'USBC_port'):
        surface(name, (0.46, 0.48, 0.51), 0.85, 0.34)
    surface('Rubber_feet', (0.025, 0.025, 0.028), 0, 0.75)
surface('Keycap', (0.012, 0.014, 0.018), 0, 0.72)
shots = json.loads((D/'shots.json').read_text())
sc.render.use_persistent_data = True
QUALITY = MODE in ('benchmark', 'final', 'anchors')
sc.render.fps = 60 if QUALITY or (D/'beat_grid.json').exists() else 30
sc.render.resolution_percentage = 100 if QUALITY else 50
sc.cycles.samples = 20 if QUALITY else 2
sc.cycles.use_denoising = QUALITY
sc.render.use_motion_blur = QUALITY
sc.render.motion_blur_shutter = 0.3
cam.animation_data_clear(); cam_d.animation_data_clear(); tgt.animation_data_clear()
proot.animation_data_clear()
# Source screen is replaced, not composited over its wallpaper.
for ob in lap_objects:
    if any(s.material and s.material.name.startswith('Display_glass') for s in ob.material_slots):
        ob.hide_render = True
for material in (bpy.data.materials['lap_scr'],bpy.data.materials['ph_scr']):
    gloss = next(n for n in material.node_tree.nodes if n.type == 'BSDF_GLOSSY')
    gloss.inputs[1].default_value = 0.18

MOVES = [
    ((-5.8,-5.0,0.35),(-4.6,-4.8,0.65),(0,0.45,0.75),(0,0.45,0.85),38,40),
    ((-4.0,-5.8,2.6),(-2.5,-5.8,2.7),(0,0.35,1.2),(0,0.4,1.2),40,42),
    ((-1.6,-5.0,2.2),(-0.35,-3.4,1.9),(0,0.65,1.45),(0,1,1.5),43,46),
    ((-4.5,-4.6,0.95),(-2.8,-5.1,1.4),(0,0.5,1.25),(0,0.5,1.25),38,40),
    ((3.7,-5.2,1.6),(3.1,-4.9,1.55),(2.1,-0.45,1.0),(2.1,-0.45,1.0),42,43),
    ((0.7,-5.8,2.2),(-1.8,-6.6,2.4),(0.65,0.4,1.1),(0.65,0.4,1.1),40,40),
]

def sequence(material, name, frames):
    node = next(n for n in material.node_tree.nodes if n.type == 'TEX_IMAGE')
    image = bpy.data.images.load(str(D/'tex'/name/'0001.jpg'),check_existing=True)
    image.source = 'SEQUENCE'; node.image = image
    node.image_user.frame_start = 1
    node.image_user.frame_offset = 0
    node.image_user.frame_duration = frames
    node.image_user.use_auto_refresh = True

def screen_frame(material, name, number):
    node = next(n for n in material.node_tree.nodes if n.type == 'TEX_IMAGE')
    files = sorted((D/'tex'/name).glob('*.jpg'))
    if not files:
        raise ValueError(f'No prepared screen frames in {D / "tex" / name}')
    path = files[min(max(number-1,0),len(files)-1)]
    old = node.image
    image = bpy.data.images.load(str(path),check_existing=True)
    image.source='FILE'
    node.image=image
    if old != image and old.users == 0:
        bpy.data.images.remove(old)

def setup(index):
    shot = shots[index]
    sc.cycles.samples = (16 if index == 4 else 20) if QUALITY else 2
    for ob in phone_objects:
        ob.hide_render = index in (1,2,3)
    count = round(shot['seconds']*sc.render.fps)
    sc.frame_start=1;sc.frame_end=count
    for obj in (cam,cam_d,tgt,proot):obj.animation_data_clear()
    for light in bpy.data.lights:light.animation_data_clear()
    for name,energy in [('key',900),('rim',700),('fill',120),('top',250)]:bpy.data.lights[name].energy=energy
    cam_d.dof.aperture_fstop = 2.8 if index == 4 else 5.6
    start,end,ta,tb,la,lb = MOVES[index]
    for f,loc,target,lens in [(1,start,ta,la),(count,end,tb,lb)]:
        cam.location=loc;cam.keyframe_insert('location',frame=f)
        tgt.location=target;tgt.keyframe_insert('location',frame=f)
        cam_d.lens=lens;cam_d.keyframe_insert('lens',frame=f)
        proot.rotation_euler=(math.radians(82),0,math.radians(-28 if f==1 else -16))
        proot.keyframe_insert('rotation_euler',frame=f)
    name = ['onboarding','onboarding','task','parallel','diff','diff'][index]
    sequence(bpy.data.materials['lap_scr'],name,600)
    sequence(bpy.data.materials['ph_scr'],'phone',300)
    for matname, strength in [('lap_scr',1.25),('ph_scr',1.0)]:
        material=bpy.data.materials[matname]
        material.node_tree.animation_data_clear()
        emission=next(n for n in material.node_tree.nodes if n.type=='EMISSION')
        emission.inputs[1].default_value=strength
        if index==0:
            emission.inputs[1].default_value=0
            emission.inputs[1].keyframe_insert('default_value',frame=1)
            emission.inputs[1].default_value=strength
            emission.inputs[1].keyframe_insert('default_value',frame=count)
    if index==0:
        for light in bpy.data.lights:
            final = light.energy
            light.energy=final*0.005;light.keyframe_insert('energy',frame=1)
            light.energy=final*0.75;light.keyframe_insert('energy',frame=count)
    return count

timings=[]
for index in range(6):
    if selected is not None and index!=selected:continue
    if MODE == 'anchors' and index != 3:continue
    count=setup(index)
    if MODE == 'anchors' or (MODE == 'final' and index == 3):
        mesh = lap_screen.data
        mesh.calc_loop_triangles()
        uv = mesh.uv_layers.active.data
        triangle = max(mesh.loop_triangles, key=lambda tri: abs(
            (uv[tri.loops[1]].uv-uv[tri.loops[0]].uv).cross(
             uv[tri.loops[2]].uv-uv[tri.loops[0]].uv)))
        uv_points = [Vector((*uv[loop].uv, 0)) for loop in triangle.loops]
        vertices = [mesh.vertices[vertex].co for vertex in triangle.vertices]
        points = [lap_screen.matrix_world @ barycentric_transform(Vector((*point, 0)),
                  *uv_points, *vertices) for point in ROW_UVS]
        tracking = {}
        for frame in range(1, count+1):
            sc.frame_set(frame)
            bpy.context.view_layer.update()
            projected = [world_to_camera_view(sc, cam, point) for point in points]
            tracking[str(frame)] = [[round(p.x*1920, 3), round((1-p.y)*1080, 3)]
                                    for p in projected]
        (D/'tracking').mkdir(exist_ok=True)
        (D/'tracking'/f'{shots[index]["name"]}.json').write_text(json.dumps(tracking))
        print('TRACKED', shots[index]['name'], count, flush=True)
        if MODE == 'anchors':continue
    # Sequences are prepared at 60 fps even when the draft is rendered at 30.
    frames = [max(1,count//2)] if MODE=='benchmark' else ([1,count//2,count] if MODE=='boards' else range(1,count+1))
    folder = D/('benchmarks' if MODE=='benchmark' else ('final_frames' if MODE=='final' else 'frames'))/shots[index]['name']
    folder.mkdir(parents=True,exist_ok=True)
    started=time.monotonic()
    for frame in frames:
        destination = folder/f'{frame:04d}.png'
        if can_resume_frame(destination, MODE):
            print('SKIP', index+1, frame, flush=True)
            continue
        sc.frame_set(frame)
        number=round((frame-1)*60/sc.render.fps)+1
        name=['onboarding','onboarding','task','parallel','diff','diff'][index]
        if index==1 and number>150:
            name='snapshot';number-=150
        screen_frame(bpy.data.materials['lap_scr'],name,number)
        screen_frame(bpy.data.materials['ph_scr'],'phone',round((frame-1)*60/sc.render.fps)+1)
        if MODE=='benchmark':bpy.ops.wm.save_as_mainfile(filepath=str(D/(shots[index]['name']+'.blend')))
        sc.render.filepath=str(folder/f'{frame:04d}.partial.png')
        before=time.monotonic();bpy.ops.render.render(write_still=True)
        os.replace(sc.render.filepath, destination)
        print('FRAME_TIME',index+1,frame,round(time.monotonic()-before,3),flush=True)
    timings.append(dict(shot=shots[index]['name'],frames=len(frames),seconds=time.monotonic()-started))
    (D/f'{MODE}_timings.json').write_text(json.dumps(timings,indent=2))
