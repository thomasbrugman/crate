"""Verify the master and produce a verified two-pass upload copy under 9.5 MB."""
import json
from pathlib import Path
import subprocess

from common import delivery_bitrate, work_parser


def verify(path, expected_frames):
    info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams',
                                             '-show_format', '-of', 'json', str(path)]))
    video = next(stream for stream in info['streams'] if stream['codec_type'] == 'video')
    audio = next(stream for stream in info['streams'] if stream['codec_type'] == 'audio')
    assert (video['codec_name'], video['width'], video['height'], video['r_frame_rate']) == (
        'h264', 1920, 1080, '60/1'), video
    assert int(video['nb_frames']) == expected_frames, video
    assert audio['codec_name'] == 'aac', audio
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'], check=True)
    print('VERIFIED', path, expected_frames, 'frames 1920x1080 60fps AAC; full decode OK', flush=True)
    return info


def main():
    parser = work_parser(__doc__)
    args = parser.parse_args()
    work = args.work_dir
    master = work/'t3stash-launch-3d.mp4'
    output = work/'t3stash-launch-3d-imessage.mp4'
    shots = json.loads((work/'shots.json').read_text())
    frames = sum(round(shot['seconds']*60) for shot in shots)
    duration = frames/60
    reports = {'master': verify(master, frames)}
    bitrate = delivery_bitrate(duration)
    options = ['-c:v', 'libx264', '-preset', 'slow', '-b:v', str(bitrate),
               '-maxrate', str(bitrate), '-bufsize', str(bitrate),
               '-pix_fmt', 'yuv420p', '-passlogfile', str(work/'delivery-pass')]
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(master), *options,
                    '-pass', '1', '-an', '-f', 'null', '/dev/null'], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(master), *options,
                    '-pass', '2', '-c:a', 'aac', '-b:a', '128k',
                    '-movflags', '+faststart', str(output)], check=True)
    assert output.stat().st_size < 9_500_000, output.stat().st_size
    reports['upload'] = verify(output, frames)
    reports['upload_bytes'] = output.stat().st_size
    (work/'delivery_verification.json').write_text(json.dumps(reports, indent=2))
    print('DELIVERY_COMPLETE', output, output.stat().st_size, 'bytes', flush=True)


if __name__ == '__main__':
    main()
