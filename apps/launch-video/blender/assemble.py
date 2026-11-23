from pathlib import Path
import subprocess
import json
from PIL import Image, ImageDraw

from common import concat_entry, work_parser
from overlays import box_overlay

parser = work_parser('Assemble rendered shots with captions, end card and music')
parser.add_argument('--final', action='store_true')
parser.add_argument('--music', type=Path, required=True)
parser.add_argument('--music-start', type=float)
args = parser.parse_args()
D = args.work_dir
shots=json.loads((D/'shots.json').read_text())
FINAL = args.final
fps = 60 if FINAL or (D/'beat_grid.json').exists() else 30
output = D/('t3stash-launch-3d.mp4' if FINAL else 'animatic.mp4')
prefix = 'final_' if FINAL else ''
music = args.music
grid = json.loads((D/'beat_grid.json').read_text()) if (D/'beat_grid.json').exists() else {}
music_start = args.music_start if args.music_start is not None else grid.get('music_start', 0)
duration = sum(round(shot['seconds']*fps) for shot in shots)/fps
def ff(*args):
    subprocess.run(['ffmpeg','-v','error','-y',*map(str,args)],check=True)

clips=[]
sheet=Image.new('RGB',(1440,7*300),'#181815')
draw=ImageDraw.Draw(sheet)
for index,shot in enumerate(shots):
    out=D/(prefix+shot['name']+'.mp4')
    count=round(shot['seconds']*fps)
    if index<6:
        folder=D/('final_frames' if FINAL else 'frames')/shot['name']
        actual=list(folder.glob('[0-9][0-9][0-9][0-9].png'))
        assert len(actual)==count,(shot['name'],len(actual),count)
        overlay = D/(shot['name']+'_overlay.png')
        overlay_args = ['-loop', 1, '-framerate', fps, '-i', overlay]
        tracking_path = D/'tracking'/f'{shot["name"]}.json'
        if index == 3:
            tracking = json.loads(tracking_path.read_text())
            font = json.loads((D/'graphics.json').read_text())['font']
            overlay_folder = D/(prefix+'caption_frames')/shot['name']
            overlay_folder.mkdir(parents=True, exist_ok=True)
            base = Image.open(overlay).convert('RGBA')
            for frame in range(1, count+1):
                source_frame = round((frame-1)*60/fps)+1
                box_overlay(base, tracking[str(source_frame)], font).save(overlay_folder/f'{frame:04d}.png')
            overlay_args = ['-framerate', fps, '-i', overlay_folder/'%04d.png']
        ff('-framerate',fps,'-i',folder/'%04d.png',*overlay_args,
           '-filter_complex',f'[0:v]scale=1920:1080:flags=lanczos[base];[1:v]format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st={shot["seconds"]-0.3}:d=0.3:alpha=1[caption];[base][caption]overlay=0:0',
           '-frames:v',count,'-c:v','libx264','-preset','fast','-crf',18,'-pix_fmt','yuv420p','-an',out)
        for column,frame in enumerate([1,count//2,count]):
            image=Image.open(folder/f'{frame:04d}.png').convert('RGBA').resize((1920,1080))
            image.alpha_composite(Image.open(overlay_folder/f'{frame:04d}.png') if index == 3 else Image.open(overlay))
            image.thumbnail((480,270));sheet.paste(image.convert('RGB'),(column*480,index*300))
            draw.text((column*480+10,index*300+278),f"{shot['name']} / {frame:04d}",fill='#f1eee5')
    else:
        ff('-loop',1,'-framerate',fps,'-i',D/'end_card.png','-frames:v',count,'-c:v','libx264',
           '-preset','fast','-crf',18,'-pix_fmt','yuv420p','-an',out)
        image=Image.open(D/'end_card.png');image.thumbnail((480,270))
        for column in range(3):sheet.paste(image,(column*480,index*300))
    clips.append(out)
sheet.save(D/(prefix+'contact_sheet.jpg'),quality=94)
(D/(prefix+'concat.txt')).write_text(''.join(concat_entry(p) for p in clips))
ff('-f','concat','-safe',0,'-i',D/(prefix+'concat.txt'),'-ss',music_start,'-i',music,
   '-map','0:v:0','-map','1:a:0','-c:v','copy','-af',
   f'aresample=48000,volume=0.48,afade=t=in:d=0.4,afade=t=out:st={duration-1.4}:d=1.4',
   '-c:a','aac','-b:a','192k','-t',duration,'-movflags','+faststart',output)
print('ASSEMBLED',output,f'{duration} seconds, {round(duration*fps)} frames at {fps} fps')
