# Launch video

The launch video opens with a seven-second Remotion simulation and then shows t3stash running
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

## Assemble the launch cut

Install Python 3.10+ with Pillow, FFmpeg with H.264 encoding, and the DejaVu Sans,
Sans Bold, and Sans Mono fonts. Put the rendered opener and the capture clips in
one directory; the script uses these filenames:

| Clip                   | Content                                                   |
| ---------------------- | --------------------------------------------------------- |
| `opener.mp4`           | Seven-second simulation                                   |
| `onboarding.mp4`       | Command Code connection in t3stash                        |
| `snapshot-setting.mp4` | Project snapshot setting                                  |
| `box-size.mp4`         | Medium Box size selection                                 |
| `readme.mp4`           | README prompt and Box startup                             |
| `install.mp4`          | Second thread reviewing install instructions              |
| `phone.mp4`            | Third thread reviewing phone pairing                      |
| `recut-workspace.mp4`  | Switch between the three threads and show the README diff |

From the repository root:

```sh
python3 apps/launch-video/cut.py /path/to/clips /path/to/launch-cut.mp4
```

Pass `--wordmark /path/to/compact-black.png` to use the approved transparent wordmark on the light
end card. Without it, the card typesets the product name.

The crop coordinates and timing are for 1440×810 captures. The three-thread montage uses separate
recordings of real threads. The phone shot is a placeholder: phone access requires an awake,
reachable t3stash host. Remove credentials and pairing links from the footage before sharing it.

Without a music file the render includes only sound cues. To audition a licensed track from its
first beat at the reveal, pass `--music /path/to/track.mp3 --music-start SECONDS`; the offset skips
into the track, not the video. Make each alternate with the same capture directory. Keep captures,
music, and exports out of git, and use the license and credit for the final publication.
