"""Portable CLI options shared by the cut tools."""
import argparse
from pathlib import Path

SHOTS = [
    dict(name='01_reveal', seconds=3.5, caption='', section='01 / REVEAL'),
    dict(name='02_setup', seconds=4.5, caption='Connect your agent once.', section='02 / SETUP'),
    dict(name='03_task', seconds=5, caption='Send a task to its own Box.', section='03 / ROUTE'),
    dict(name='04_parallel', seconds=5, caption='Three jobs. Three separate Boxes.', section='04 / IN TRANSIT'),
    dict(name='05_phone', seconds=5, caption='Same thread. Now on your phone.', section='05 / MOBILE'),
    dict(name='06_delivery', seconds=3.5, caption='The README diff is back.', section='06 / DELIVERY'),
    dict(name='07_end', seconds=4, caption='', section='07 / END OF ROUTE'),
]
ROW_UVS = [(.16, 1-144/810), (.16, 1-207/810), (.16, 1-270/810)]


def work_parser(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument('work_dir', type=lambda p: Path(p).expanduser().resolve())
    return parser


def render_options(parser):
    parser.add_argument('--laptop-model', type=Path)
    parser.add_argument('--laptop-screen', default='Object_23')
    parser.add_argument('--phone-model', type=Path)
    parser.add_argument('--phone-screen', default='xXDHkMplTIDAXLN')
    parser.add_argument('--finish', choices=('silver', 'yellow'), default='silver')
    parser.add_argument('--lid-tilt', type=float, default=-12)


def concat_entry(path):
    return "file '" + str(path).replace("'", "'\\''") + "'\n"


def beat_cuts(shots, bpm, cuts, fps=60):
    if bpm <= 0 or len(cuts) != len(shots) + 1 or cuts[0] != 0:
        raise ValueError('Need a positive tempo and one more boundary than shots, starting at zero')
    frames = [round(beat * 60 / bpm * fps) for beat in cuts]
    if any(b <= a for a, b in zip(frames, frames[1:])):
        raise ValueError('Cuts must be strictly increasing by at least one frame')
    return [dict(shot, seconds=(end-start)/fps, start_frame=start, frames=end-start,
                 caption_start_frame=0)
            for shot, start, end in zip(shots, frames, frames[1:])]


def delivery_bitrate(duration):
    if duration <= 0:
        raise ValueError('Duration must be positive')
    return min(2_150_000, max(1, int(9_000_000*8/duration)-128_000))


def complete_png(path):
    if not path.exists() or path.stat().st_size < 20:
        return False
    with path.open('rb') as image:
        if image.read(8) != bytes.fromhex('89504e470d0a1a0a'):
            return False
        image.seek(-12, 2)
        return image.read() == bytes.fromhex('0000000049454e44ae426082')


def can_resume_frame(path, mode):
    return mode == 'final' and complete_png(path)
