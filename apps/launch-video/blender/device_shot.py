"""Shared studio scene, real-model normalization and aspect-preserving screen UVs."""
import math
import os
from types import SimpleNamespace

import bpy
from mathutils import Matrix, Vector


def build_scene(work_dir, laptop_model, laptop_screen_name, phone_model,
                phone_screen_name, lid_tilt=-12):
    D = str(work_dir)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    FPS, N = 60, 300
    sc.render.fps = FPS; sc.frame_start = 1; sc.frame_end = N
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 20
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.02
    sc.cycles.use_denoising = True
    sc.render.use_persistent_data = True
    sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    sc.cycles.max_bounces = 4; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 2; sc.cycles.transmission_bounces = 2
    sc.cycles.caustics_reflective = False; sc.cycles.caustics_refractive = False
    sc.render.resolution_x = 1920; sc.render.resolution_y = 1080
    sc.render.resolution_percentage = 100
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

    screen_mat("lap_scr", "onboarding", 600, 1.25)
    screen_mat("ph_scr", "phone", 300, 1.0)
    root = bpy.data.objects.new("laptop", None); sc.collection.objects.link(root)
    proot = bpy.data.objects.new("phone", None); sc.collection.objects.link(proot)
    proot.location = (2.35,-0.75,0.82); proot.rotation_euler = (math.radians(82),0,math.radians(-28))

    def import_device(glb_path, parent, screen_name, scale=1.0, transform=lambda p: p):
        previous = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=glb_path)
        imported = set(bpy.data.objects) - previous
        meshes = [o for o in imported if o.type == 'MESH']
        screen = next(o for o in meshes if o.name == screen_name)
        if parent == root and lid_tilt:
            lid_parent = screen.parent
            pivot = Vector((0, screen.matrix_world.translation.y, 0))
            correction = Matrix.Translation(pivot) @ Matrix.Rotation(math.radians(lid_tilt),4,'X') @ Matrix.Translation(-pivot)
            for item in meshes:
                if item.parent == lid_parent:
                    item.matrix_world = correction @ item.matrix_world
        for ob in meshes:
            world = ob.matrix_world.copy()
            for vertex in ob.data.vertices:
                vertex.co = Vector(transform(world @ vertex.co)) * scale
            ob.parent = parent
            ob.matrix_parent_inverse.identity()
            ob.matrix_basis.identity()
            ob.name = os.path.basename(os.path.dirname(glb_path)) + '_' + ob.name
        for ob in imported:
            if ob.type != 'MESH':
                bpy.data.objects.remove(ob, do_unlink=True)
        return meshes, screen

    phone_objects, phone_screen = import_device(
        str(phone_model),
        proot, phone_screen_name, 1.52 / 0.159543328,
        lambda p: (-p.x, p.z, p.y))

    def fit_screen(screen, material, aspect, upright, letterbox=False):
        mesh = screen.data
        mesh.materials.clear()
        mesh.materials.append(material)
        for face in mesh.polygons:
            face.material_index = 0
        uv = mesh.uv_layers.active or mesh.uv_layers.new(name='VideoUV')
        up = Vector(upright).normalized()
        xs = [v.co.x for v in mesh.vertices]
        ys = [v.co.dot(up) for v in mesh.vertices]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        ratio = w / h
        sx, sy = 1.0, 1.0
        if letterbox:
            if ratio < aspect:
                sy = aspect / ratio
            else:
                sx = ratio / aspect
        elif ratio < aspect:
            sx = ratio / aspect
        else:
            sy = aspect / ratio
        for loop in mesh.loops:
            p = mesh.vertices[loop.vertex_index].co
            uv.data[loop.index].uv = ((p.x - cx) / w * sx + 0.5,
                                      (p.dot(up) - cy) / h * sy + 0.5)

    def import_laptop(glb_path, screen_object_name):
        objects, screen = import_device(glb_path, root, screen_object_name)
        points = [v.co.copy() for ob in objects for v in ob.data.vertices]
        low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
        high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
        scale = 3.0 / (high.x - low.x)
        base_points = [p for p in points if p.z <= low.z + (high.z - low.z) * 0.08]
        center_y = (min(p.y for p in base_points) + max(p.y for p in base_points)) / 2
        offset = Vector(((low.x + high.x) / 2, center_y, low.z))
        for ob in objects:
            for vertex in ob.data.vertices:
                vertex.co = (vertex.co - offset) * scale
            ob.data.update()
        normal = sum((p.normal * p.area for p in screen.data.polygons), Vector()).normalized()
        up = Vector((0, 0, 1))
        up = (up - normal * up.dot(normal)).normalized()
        fit_screen(screen, bpy.data.materials['lap_scr'], 16 / 9, up, letterbox=True)
        return objects, screen

    lap_objects, lap_screen = import_laptop(
        str(laptop_model), laptop_screen_name)
    fit_screen(phone_screen, bpy.data.materials['ph_scr'], 1206 / 2622, (0, 1, 0))

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

    cam_d = bpy.data.cameras.new("cam"); cam = bpy.data.objects.new("cam",cam_d); sc.collection.objects.link(cam); sc.camera = cam
    cam_d.dof.use_dof = True; cam_d.sensor_width = 36
    cam_d.dof.aperture_fstop = 5.6
    tgt = bpy.data.objects.new("tgt",None); sc.collection.objects.link(tgt)
    cam_d.dof.focus_object = tgt
    c = cam.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis='TRACK_NEGATIVE_Z'; c.up_axis='UP_Y'
    return SimpleNamespace(sc=sc, cam=cam, cam_d=cam_d, tgt=tgt, proot=proot,
                           lap_objects=lap_objects, lap_screen=lap_screen, phone_objects=phone_objects)
