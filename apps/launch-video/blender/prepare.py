from pathlib import Path
import subprocess
import json
import runpy
from PIL import Image, ImageDraw, ImageFont

from common import SHOTS, work_parser

parser = work_parser('Prepare audited screen sequences, captions and end card')
parser.add_argument('--clips', type=Path, help='Source clips directory (default: WORK_DIR/clips)')
parser.add_argument('--font', type=Path, required=True, help='Inter variable TTF (optical size/weight axes)')
parser.add_argument('--graphics-only', action='store_true')
parser.add_argument('--style-script', type=Path, default=Path(__file__).resolve().parent.parent/'cut.py')
args = parser.parse_args()
D = args.work_dir
D.mkdir(parents=True, exist_ok=True)
C = args.clips or D/'clips'
STYLE = runpy.run_path(str(args.style_script))
shots = json.loads((D/'beat_grid.json').read_text())['shots'] if (D/'beat_grid.json').exists() else SHOTS
(D/'shots.json').write_text(json.dumps(shots, indent=2))
(D/'graphics.json').write_text(json.dumps(dict(font=str(args.font.resolve()))))

def extract(name, file, start, seconds, vf='null'):
    if args.graphics_only:
        return
    folder = D/'tex'/name
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(C/file),
        '-vf',vf+',fps=60,tpad=stop_mode=clone:stop_duration=8', '-frames:v',str(round(seconds*60)),
        '-q:v','3',str(folder/'%04d.jpg')],check=True)

# Already-saved credential fields only; mask the entire Box configuration panel.
extract('onboarding','onboarding.mp4',0.1,2.6,
        'drawbox=x=345:y=130:w=750:h=230:color=black:t=fill')
extract('snapshot','snapshot-setting.mp4',0.42,2,
        'drawbox=x=1010:y=705:w=290:h=55:color=0x181818:t=fill')
extract('task','readme.mp4',2.8,5)
extract('parallel','recut-workspace.mp4',0.85,5)
extract('diff','recut-workspace.mp4',10,3.5)
# Preserve the established Safari/composer crop; no browser chrome or Setup-required row.
extract('phone','t3stash-readme-phone-60fps.mp4',0,5,
        'drawbox=x=0:y=1980:w=1206:h=642:color=0xf9f9f9:t=fill,drawbox=x=450:y=2555:w=306:h=12:color=0x181818:t=fill')

caption_font = ImageFont.truetype(str(args.font), 50)
caption_font.set_variation_by_axes([14, 600])
label_font = ImageFont.truetype(str(args.font), 22)
for shot in shots[:-1]:
    image = Image.new('RGBA',(1920,1080))
    draw = ImageDraw.Draw(image)
    if shot['caption']:
        phone = shot['name'] == '05_phone'
        x, y = (1320, 400) if phone else (96, 60)
        caption = 'Same thread.\nNow on your phone.' if phone else shot['caption']
        draw.text((x,y),shot['section'],font=label_font,fill='#a8acb3',stroke_width=1,stroke_fill='#00000066')
        draw.multiline_text((x,y+42),caption,font=caption_font,spacing=12,fill='white',stroke_width=1,stroke_fill='#00000066')
    image.save(D/(shot['name']+'_overlay.png'))
end = STYLE['title_card'](C/'wordmark.png', 'Music: Bridge of Roses by Ian Aisling')
draw = ImageDraw.Draw(end)
draw.text((960,822),'3D: MacBook Neo — Ranguel · iPhone 15 Pro Max Black — polyman Studio',
          anchor='mm',font=STYLE['font'](22),fill=STYLE['MUTED'])
draw.text((960,855),'CC BY 4.0 · Screen content, materials and animation adapted',
          anchor='mm',font=STYLE['font'](20),fill=STYLE['MUTED'])
end.save(D/'end_card.png')

(D/'model_credits.txt').write_text('''"MacBook Neo" by Ranguel
https://sketchfab.com/3d-models/macbook-neo-f3dd26684f114b1baffd1b0800876627
"Apple iPhone 15 Pro Max Black" by polyman Studio (Polyman_3D)
https://sketchfab.com/3d-models/apple-iphone-15-pro-max-black-df17520841214c1792fb8a44c6783ee7
Both models: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
Adaptations: lid pose, scale/orientation, display footage/UVs, materials, lighting and animation.
Music: Bridge of Roses by Ian Aisling. Original track played at normal speed.
''')
