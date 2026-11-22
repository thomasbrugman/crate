# Launch video

The launch video opens with a simulated thermal-printer jam and a t3stash dispatch reveal.
Then it follows the README work order through real Box threads on this repository. The opener
does not need an app server, credentials, or remote assets.

From the repository root:

```sh
vp i
vp run --filter @t3tools/launch-video render:opener
```

The 1080p/60 fps H.264 export is `out/opener.mp4` inside this package (ignored by git).
Use `vp run --filter @t3tools/launch-video studio` to preview `Opener`.
Remotion may download headless Chrome on the first render.

The scene imports the real web Button, Badge, and Spinner components and web theme CSS.
Local webpack shims isolate their translation and class-name helpers from application stores.
The manifest excerpt comes from this repository's MIT-licensed root manifest. The freeze remains
simulated. All animation, including spinner rotation and the unsuccessful click, is frame-driven.

## Assemble the launch cut

Install Python 3.10+ with Pillow, FFmpeg with H.264 encoding and FFprobe, and the
DejaVu Sans, Sans Bold, and Sans Mono fonts. Put the rendered opener and the
capture clips in one directory; the script uses these filenames:

| Clip                   | Content                                                   |
| ---------------------- | --------------------------------------------------------- |
| `opener.mp4`           | 8.6-second printer-jam simulation and dispatch reveal     |
| `onboarding.mp4`       | Numbered Box setup and the saved Command Code connection  |
| `snapshot-setting.mp4` | Project snapshot setting                                  |
| `box-size.mp4`         | Medium Box size selection                                 |
| `readme.mp4`           | README prompt and Box startup                             |
| `install.mp4`          | Second thread reviewing install instructions              |
| `phone.mp4`            | Third thread reviewing phone pairing                      |
| `recut-workspace.mp4`  | Switch between the three threads and show the README diff |
| `mobile-readme.mp4`    | Open the same completed README thread in the phone layout |

From the repository root:

```sh
python3 apps/launch-video/cut.py /path/to/clips /path/to/launch-cut.mp4
```

Pass `--wordmark /path/to/compact-black.png` to use the approved transparent wordmark on the light
end card. Without it, the card typesets the product name.

Capture desktop footage at 1440×810 and 60 fps, and use a portrait 60 fps clip for the phone.
Record the numbered onboarding screen after saving credentials, not during entry. The montage
uses separate recordings of real threads. For the phone shot, open the same README thread from
the sidebar and show the diff. Phone access requires an awake, reachable t3stash host. Remove
credentials and pairing links before sharing footage.

Without a music file the render includes only sound cues. To audition a licensed track from its
first beat at the reveal, pass `--music /path/to/track.mp3 --music-start SECONDS`; the offset skips
into the track, not the video. Add `--music-credit "Track — Artist (Source)"` for an end-card credit.
This does not replace the library's download credit in the published video description. Make each
alternate with the same capture directory and keep captures, music, and exports out of git.

## 3D device shot

`blender/device_shot.py` builds a Blender scene with a laptop and a phone on a dark studio floor,
plays real captures on both screens, and moves the camera in a 5-second arc and push-in
(1080p, 60 fps, Cycles on CPU). It was written for Blender 4.2 LTS.

Extract the screen frames into a work directory, then build and render:

```sh
mkdir -p work/tex/laptop work/tex/phone
ffmpeg -ss 5.5 -t 6 -i clips/readme.mp4 -vf fps=60 -q:v 2 work/tex/laptop/%04d.jpg
ffmpeg -i clips/t3stash-readme-phone-60fps.mp4 \
  -vf "fps=60,crop=1206:1780:0:0,pad=1206:2622:0:0:color=0xfafafa,drawbox=x=453:y=2566:w=300:h=14:color=black@0.85:t=fill" \
  -q:v 2 work/tex/phone/%04d.jpg
blender -b -P apps/launch-video/blender/device_shot.py -- work
blender -b work/scene.blend -o //out/f_#### -a
ffmpeg -framerate 60 -i work/out/f_%04d.png -c:v libx264 -pix_fmt yuv420p -crf 16 device-shot.mp4
```

Pass `preview` after the work directory for a half-resolution, low-sample scene. On an 8-core CPU
a full frame takes about 10 seconds. The laptop needs at least 300 frames for the whole shot; the
phone holds its last frame. The phone filter crops the composer and the Safari bar off the
1206×2622 capture and fills the space with the thread background and a home indicator. Keep work directories and renders out of git.
