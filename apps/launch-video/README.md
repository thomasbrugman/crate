# Launch video

The first cut opens with a seven-second Remotion simulation and then shows t3stash running
real threads on this repository. Rendering the opener does not require an app server,
credentials, or remote assets.

From the repository root:

```sh
vp i
vp run --filter @t3tools/launch-video render:opener
```

The H.264 export is `out/opener.mp4` inside this package (ignored by git).
Use `vp run --filter @t3tools/launch-video studio` to preview `Opener`.
Remotion may download headless Chrome on the first render.

The scene imports the real web Button, Badge, Skeleton, and Spinner components and web theme CSS.
Local webpack shims isolate their translation and class-name helpers from application stores.
All animation, including spinner rotation and the unsuccessful click, is frame-driven.

## Assemble the first cut

Install Python 3.10+ with Pillow, FFmpeg with H.264 encoding, and the DejaVu Sans,
Sans Bold, and Sans Mono fonts. Put the rendered opener and the capture clips in
one directory; the script uses these filenames:

| Clip                   | Content                                      |
| ---------------------- | -------------------------------------------- |
| `opener.mp4`           | Seven-second simulation                      |
| `onboarding.mp4`       | Command Code connection in t3stash           |
| `stage.mp4`            | Staging Box setup and snapshot creation logs |
| `snapshot-setting.mp4` | Project snapshot setting                     |
| `box-size.mp4`         | Medium Box size selection                    |
| `readme.mp4`           | README prompt and Box startup                |
| `install.mp4`          | Second thread reviewing install instructions |
| `phone.mp4`            | Third thread reviewing phone pairing         |
| `inventory.mp4`        | Box inventory from the SDK                   |
| `return-to-readme.mp4` | Switch back to the first thread              |
| `result.mp4`           | README diff reported by the agent            |

From the repository root:

```sh
python3 apps/launch-video/cut.py /path/to/clips /path/to/first-cut.mp4
```

The crop coordinates and timing are for the original 1440×810 captures. The edit adds
captions, generated sound cues, a placeholder for the camera insert, and a GitHub
call to action. The setup and inventory shots are labeled SDK footage, not app or
dashboard UI. Phone access requires an awake, reachable t3stash host. Keep the
capture clips and exports out of git, and remove credentials and pairing links from
the footage before sharing it.
