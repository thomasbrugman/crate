"""Resumable final render and automatic assembly (POSIX lock)."""
from pathlib import Path
import datetime
import fcntl
import subprocess
import sys

from common import render_options, work_parser

parser = work_parser(__doc__)
render_options(parser)
parser.add_argument('--blender', default='blender')
parser.add_argument('--threads', type=int, default=12)
parser.add_argument('--music', type=Path, required=True)
parser.add_argument('--music-start', type=float)
args = parser.parse_args()
D = args.work_dir
D.mkdir(parents=True, exist_ok=True)
SCRIPTS = Path(__file__).resolve().parent
lock = (D/'final_render.lock').open('w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
options = ['--finish', args.finish, '--lid-tilt', str(args.lid_tilt),
           '--laptop-screen', args.laptop_screen, '--phone-screen', args.phone_screen]
for name in ('laptop_model', 'phone_model'):
    value = getattr(args, name)
    if value:
        options.extend(['--'+name.replace('_', '-'), str(value.resolve())])
music_options = ['--music-start', str(args.music_start)] if args.music_start is not None else []
with (D/'final_render.log').open('a', buffering=1) as log:
    print('FINAL_START', datetime.datetime.now(datetime.timezone.utc).isoformat(), file=log)
    try:
        subprocess.run([args.blender, '-b', '-t', str(args.threads), '--python-exit-code', '1',
                        '--python', str(SCRIPTS/'render_shots.py'), '--', str(D), '--mode', 'final',
                        *options], check=True, stdout=log, stderr=subprocess.STDOUT,
                       pass_fds=(lock.fileno(),))
        subprocess.run([sys.executable, str(SCRIPTS/'assemble.py'), str(D), '--final',
                        '--music', str(args.music.resolve()), *music_options],
                       check=True, stdout=log, stderr=subprocess.STDOUT,
                       pass_fds=(lock.fileno(),))
        subprocess.run([sys.executable, str(SCRIPTS/'deliver.py'), str(D)],
                       check=True, stdout=log, stderr=subprocess.STDOUT,
                       pass_fds=(lock.fileno(),))
    except Exception as error:
        print('FINAL_FAILED', repr(error), file=log)
        raise
    print('FINAL_COMPLETE', datetime.datetime.now(datetime.timezone.utc).isoformat(), file=log)
