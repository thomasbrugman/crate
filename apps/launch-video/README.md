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

## Full 3D launch cut

The Blender 4.2 LTS pipeline in `blender/` renders six independent device shots and a
credited end card: about 31 seconds at 1080p/60 fps. Use Python 3.10+, Pillow, NumPy, FFmpeg,
Blender with Cycles/OpenImageDenoise, DejaVu Sans fonts (for the existing end card),
and an [Inter variable TTF](https://github.com/google/fonts/tree/main/ofl/inter)
(optical-size and weight axes). Keep **all assets and outputs outside the checkout**.

### Get the models

Models are not included. The four source/download links for the two models are:

| Model                         | Original source / author                                                                                                                   | Download                                                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MacBook Neo                   | [Ranguel on Sketchfab](https://sketchfab.com/3d-models/macbook-neo-f3dd26684f114b1baffd1b0800876627)                                       | [Sketchfab download API](https://api.sketchfab.com/v3/models/f3dd26684f114b1baffd1b0800876627/download), authenticated with your own `SKETCHFAB_API_TOKEN` |
| Apple iPhone 15 Pro Max Black | [polyman Studio (Polyman_3D) on Sketchfab](https://sketchfab.com/3d-models/apple-iphone-15-pro-max-black-df17520841214c1792fb8a44c6783ee7) | [Direct GLB](https://raw.githubusercontent.com/adrianhajdin/iphone/main/public/models/scene.glb)                                                           |

Use `curl -fsS -H "Authorization: Token ${SKETCHFAB_API_TOKEN:?Set your own token}"`
with the Neo download endpoint. Read the returned `glb.url` (or `gltf.url` for a
ZIP), then download it before its signed URL expires. Never log/commit the token or
signed URLs. If only glTF is available, extract its ZIP and import/export it as GLB
in Blender, preserving mesh names. No token is needed for the iPhone direct URL.

Place the GLBs at `WORK/models/macbook-neo-ranguel/model.glb` and
`WORK/models/iphone-15-pro-max-polyman/model.glb`. Displays are `Object_23` and
`xXDHkMplTIDAXLN`, respectively. The shared `device_shot.build_scene` contains the
generic import/normalization/UV helpers; there is no second scene copy or source
rewriting. A different open, Z-up/X-wide laptop can use `--laptop-model`,
`--laptop-screen` and `--lid-tilt 0` (the Neo defaults to -12 degrees).
Keep the default-model credits only when those are the models actually used.

Both models allow commercial use under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Publish these credits with the video (also generated in `WORK/model_credits.txt`):

> "MacBook Neo" by Ranguel; "Apple iPhone 15 Pro Max Black" by polyman Studio
> (Polyman_3D), CC BY 4.0. Sources: the original Sketchfab links above.
> Adaptations: lid pose, scale/orientation, screen footage/UVs, materials,
> studio lighting and animation.

### Prepare, preview, render

Stage `onboarding.mp4`, `snapshot-setting.mp4`, `readme.mp4`,
`recut-workspace.mp4`, `t3stash-readme-phone-60fps.mp4` (1206×2622 portrait) and
`wordmark.png` in `WORK/clips/`. Supply your licensed music separately.

For a beat-synced cut, run the onset analysis before preparation:

```sh
python3 apps/launch-video/blender/beat_sync.py /path/to/music.mp3 WORK
```

This writes `beat_grid.json` (tempo, phase, onset evidence, music offset and cut frames)
and `shots.json`. The Bridge of Roses arrangement uses 96 BPM, a 2.380-second offset,
and beat boundaries `0,6,14,22,30,38,44,50`: 31.25 seconds, exactly 1,875 frames.
The grid is estimated from onsets, not an authoritative musical meter transcription;
inspect the printed peak times and audition before using a different track. Override
`--start-beat` and `--cut-beats` to choose a different arrangement. Preparation preserves
the grid; assembly and the runner automatically use its music offset unless overridden.
Beat-synced animatics also use 60 fps, at half resolution/two samples, so cuts remain exact.

Shot 4 uses editorial `BOX 01/02/03` callouts for the visible phone-docs, macOS-review
and Node-version task rows, not captured Box IDs. Generate their per-frame screen anchors
with the same model/finish/lid options as the render:

```sh
blender -b --python apps/launch-video/blender/render_shots.py -- WORK --mode anchors
```

Assembly uses `tracking/04_parallel.json` and `graphics.json` to create crisp tracked overlays.
If retiming an existing cut, archive the affected shot directories in both `frames/` and
`final_frames/` before rendering. Final rendering assumes existing PNGs are valid;
animatics always overwrite frames to avoid mixing preview frame rates. Reuse only shots whose
duration, camera, model, materials, lights and screen sequences are unchanged. The three
five-second task/parallel/phone shots remain reusable in this arrangement; labels are 2D.
After final assembly, the runner verifies 1080p60/AAC and full-decodes the master, then makes
`t3stash-launch-3d-imessage.mp4` with two-pass H.264 (up to 2150k video / 128k AAC), checks
it is below 9,500,000 bytes and decodes it too. Results go to `delivery_verification.json`.
Run `python3 apps/launch-video/blender/deliver.py WORK` to repeat delivery without rerendering.
The track credit is “Music: Bridge of Roses by Ian Aisling”.
Masks and in-points match the audited launch captures: **inspect every new source
segment for credentials and raw Upstash data before rendering**. Fixed pixel masks
are not automatic redaction and must be adjusted if captures/layouts change.

Run from the repo root, substituting your own paths:

```sh
WORK=/path/outside/repo/launch-work
TOOLS=apps/launch-video/blender
python3 "$TOOLS/prepare.py" "$WORK" --font /path/to/Inter-variable.ttf
blender -b -t 12 --python-exit-code 1 -P "$TOOLS/render_shots.py" -- "$WORK" --mode animatic
python3 "$TOOLS/assemble.py" "$WORK" --music /path/to/bridge-of-roses.mp3
blender -b -t 12 --python-exit-code 1 -P "$TOOLS/render_shots.py" -- "$WORK" --mode benchmark
```

The animatic is `WORK/animatic.mp4` (30 fps, 50% device renders, two samples).
Inspect `WORK/contact_sheet.jpg` and the full-quality midpoint PNGs in
`WORK/benchmarks/<shot>/`; measured timings are printed as `FRAME_TIME`.
Use `--shot 1` through `--shot 6` to select a shot. Final quality uses 20 samples,
16 for the phone, with denoising and motion blur. The silver finish is default;
`--finish yellow` restores the model's body color while keeping dark matte keys.

Once previews are approved:

```sh
nohup python3 "$TOOLS/run_final.py" "$WORK" --blender blender --threads 12 \
  --music /path/to/bridge-of-roses.mp3 > "$WORK/runner.log" 2>&1 < /dev/null &
```

This POSIX runner locks the work directory, appends progress to
`WORK/final_render.log`, then automatically writes
`WORK/t3stash-launch-3d.mp4` and `WORK/final_contact_sheet.jpg`.
Rerun the same command after interruption: completed PNGs are skipped and frame
writes are atomic. Use a **new work directory** after changing models, cameras,
finish or render settings; existing frames are not invalidated automatically.
Caption-only updates can use `prepare.py ... --graphics-only` while rendering;
assembly reads the updated overlays afterwards. Phone text is right of the device;
other captions are top-left, with 0.3-second fades. The end card is unchanged.

`--music-start SECONDS` is accepted by assembly and the final runner; default 0,
normal playback speed, with fade-in/out. The cut contains 1,590 rendered frames plus
240 end-card frames; budget roughly 6–7 hours on a comparable 12-thread CPU, but
benchmark on your own machine. No render starts merely by importing the scene helper.
