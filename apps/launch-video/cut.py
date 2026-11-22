"""Assemble the t3stash launch cut from the staged opener and recorded footage."""

import argparse
import math
from pathlib import Path
import random
import struct
import subprocess
import tempfile
import wave
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT, FPS = 1920, 1080, 30
REPO = "github.com/thomasbrugman/t3stash"
REVEAL_AT = 7
REVEAL_LENGTH = 1.8
CAMERA_LENGTH = 3.3
CTA_LENGTH = 4
SCREEN = (1656, 896)
PAPER = "#f2f1ee"
INK = "#191918"
MUTED = "#545351"
ENCODE = [
    "-r",
    str(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-an",
]


@dataclass(frozen=True)
class Shot:
    file: str
    length: float
    section: str
    caption: str
    start: float = 0
    speed: float = 1
    crop: tuple[int, int, int, int] | None = None  # width, height, x, y
    note: str = ""


SHOTS = (
    Shot(
        "onboarding.mp4",
        3.2,
        "CONNECT",
        "Connect your agent once.",
        0.25,
    ),
    Shot(
        "snapshot-setting.mp4",
        3.2,
        "PREPARE",
        "Start new threads from a prepared snapshot.",
        3.6,
        crop=(984, 468, 350, 320),
    ),
    Shot(
        "box-size.mp4",
        3.5,
        "START A THREAD",
        "Pick a Box size.",
        crop=(884, 452, 354, 175),
    ),
    Shot(
        "readme.mp4",
        4.8,
        "START A THREAD",
        "Send a task to its own Box.",
        1.35,
        1.6,
        note="FOOTAGE SPED UP",
    ),
)
PARALLEL_LENGTH = 4.2
PARALLEL = (
    ("readme.mp4", 6.25, "README EDIT"),
    ("install.mp4", 5.0, "INSTALL REVIEW"),
    ("phone.mp4", 4.35, "PHONE PAIRING"),
)
RESULT = (
    Shot(
        "recut-workspace.mp4",
        5.4,
        "CHECK THE WORK",
        "Switch between threads.",
        1.15,
        1.7,
        note="FOOTAGE SPED UP",
    ),
    Shot(
        "recut-workspace.mp4",
        3.4,
        "CHECK THE WORK",
        "The README diff, straight from the Box.",
        10.35,
        crop=(886, 435, 350, 130),
    ),
)


def ffmpeg(*args):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
        check=True,
    )


def font(size, kind="sans"):
    name = {
        "sans": "DejaVuSans.ttf",
        "bold": "DejaVuSans-Bold.ttf",
        "mono": "DejaVuSansMono.ttf",
    }[kind]
    return ImageFont.truetype(name, size)


def canvas():
    return Image.new("RGB", (WIDTH, HEIGHT), PAPER)


def center(draw, text, y, size, color=INK, kind="sans"):
    draw.text((WIDTH // 2, y), text, anchor="mm", font=font(size, kind), fill=color)


def title_card(kind, wordmark=None):
    card = canvas()
    draw = ImageDraw.Draw(card)
    if kind == "camera":
        center(draw, "CAMERA INSERT", 360, 24, MUTED, "mono")
        center(draw, "Same thread. Now on your phone.", 475, 70, kind="bold")
        center(draw, "Thomas’s lid-and-phone shot goes here", 575, 34, MUTED)
        center(
            draw,
            "Phone access needs an awake, reachable t3stash host.",
            755,
            32,
            MUTED,
        )
        return card

    if kind == "intro":
        center(draw, "t3stash", 488, 154, kind="bold")
        center(draw, "T3 Code threads in their own cloud Boxes.", 662, 47)
    else:
        if wordmark:
            with Image.open(wordmark) as source:
                logo = source.convert("RGBA")
            logo.thumbnail((710, 175), Image.Resampling.LANCZOS)
            card.paste(logo, ((WIDTH - logo.width) // 2, 488 - logo.height // 2), logo)
        else:
            center(draw, "t3stash", 488, 154, kind="bold")
        center(draw, REPO, 668, 43, kind="mono")
        center(draw, "Built on T3 Code and Upstash Box.", 854, 29, MUTED)
    return card


def shot_card(shot):
    card = canvas()
    draw = ImageDraw.Draw(card)
    if shot.note:
        draw.text((1792, 46), shot.note, anchor="rm", font=font(21, "mono"), fill=MUTED)
    draw.text((960, 1022), shot.caption, anchor="mm", font=font(49, "bold"), fill=INK)
    return card


def still(image, output, length):
    ffmpeg("-loop", "1", "-framerate", FPS, "-i", image, "-t", length, *ENCODE, output)


def footage(shot, inputs, plate, output):
    path = inputs / shot.file
    crop = "" if shot.crop is None else f"crop={':'.join(map(str, shot.crop))},"
    frames = round(shot.length * FPS)
    width, height = shot.crop[:2] if shot.crop else (1440, 810)
    scale = min(SCREEN[0] / width, SCREEN[1] / height)
    width, height = (2 * round(d * scale / 2) for d in (width, height))
    graph = (
        f"[0:v]{crop}setpts=(PTS-STARTPTS)/{shot.speed},fps={FPS},"
        f"tpad=stop_mode=clone:stop_duration={shot.length},"
        f"scale={width * 2}:{height * 2},"
        f"zoompan=z='1+0.065*(1-cos(PI*min(on/{frames - 1},1)))/2':"
        f"x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={width}x{height}:fps={FPS},"
        "setsar=1[screen];"
        "[1:v][screen]overlay=(W-w)/2:(H-h)/2[out]"
    )
    ffmpeg(
        "-ss",
        shot.start,
        "-i",
        path,
        "-loop",
        "1",
        "-framerate",
        FPS,
        "-i",
        plate,
        "-filter_complex_threads",
        1,
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        "-frames:v",
        frames,
        *ENCODE,
        output,
    )


def parallel(inputs, plate, output):
    card = shot_card(
        Shot(
            "",
            PARALLEL_LENGTH,
            "RUN IN PARALLEL",
            "Three tasks. Three separate Boxes.",
            note="THREE REAL THREADS · MONTAGE",
        )
    )
    draw = ImageDraw.Draw(card)
    args = ["-loop", "1", "-framerate", FPS, "-i", plate]
    graph = []
    for i, (name, start, label) in enumerate(PARALLEL):
        delay = i * 0.58
        x, y = 460 + i * 165, 170 + i * 258
        draw.text(
            (x - 24, y + 114),
            f"0{i + 1} / {label}",
            anchor="rm",
            font=font(23, "mono"),
            fill=INK,
        )
        args += ["-ss", start, "-i", inputs / name]
        graph.append(
            f"[{i + 1}:v]crop=1000:236:275:28,fps={FPS},setsar=1,"
            "drawbox=c=0x484854:w=iw:h=ih:t=2,"
            f"tpad=stop_mode=clone:stop_duration={PARALLEL_LENGTH},"
            f"setpts=PTS-STARTPTS+{delay}/TB[clip{i}]"
        )
        base = "0:v" if i == 0 else f"row{i - 1}"
        graph.append(
            f"[{base}][clip{i}]overlay="
            f"x='{x}+220*pow(max(0,1-(t-{delay})/0.48),3)':"
            f"y={y}:enable='gte(t,{delay})'[row{i}]"
        )
    card.save(plate)
    ffmpeg(
        *args,
        "-filter_complex_threads",
        1,
        "-filter_complex",
        ";".join(graph),
        "-map",
        f"[row{len(PARALLEL) - 1}]",
        "-frames:v",
        round(PARALLEL_LENGTH * FPS),
        *ENCODE,
        output,
    )


def sound(output, length, title_at, cta_at):
    rate = 24000
    rng = random.Random(24)
    low_noise = 0.0
    samples = bytearray()
    for i in range(round(rate * length)):
        t = i / rate
        low_noise = 0.92 * low_noise + 0.08 * rng.uniform(-1, 1)
        fan = 0.0
        if t < title_at:
            ramp = min(1, t / 1.3) * min(1, (title_at - t) / 0.13)
            fan = (
                ramp
                * (0.018 + 0.04 * t / title_at)
                * (2.8 * low_noise + math.sin(2 * math.pi * (64 * t + 2.2 * t * t)))
            )
        cue = 0.0
        for when, root, gain in ((title_at, 55, 0.17), (cta_at, 165, 0.07)):
            age = t - when
            if 0 <= age < 1.6:
                cue += (
                    gain
                    * min(1, age * 122)
                    * math.exp(-4 * age)
                    * (
                        math.sin(2 * math.pi * root * age)
                        + 0.17 * math.sin(2 * math.pi * 2.5 * root * age)
                    )
                )
        samples.extend(struct.pack("<h", round(32767 * (fan + cue))))
    with wave.open(str(output), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(samples)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "footage", type=Path, help="Directory containing the recorded MP4s"
    )
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--wordmark", type=Path, help="Transparent PNG for the end card"
    )
    parser.add_argument("--music", type=Path, help="Licensed music file for this cut")
    parser.add_argument(
        "--music-start",
        type=float,
        default=0,
        help="Skip this many seconds into the music",
    )
    args = parser.parse_args()
    if (
        not math.isfinite(args.music_start)
        or args.music_start < 0
        or (args.music_start and not args.music)
    ):
        parser.error("--music-start must be nonnegative and used with --music")
    if args.music and not args.music.is_file():
        parser.error(f"music not found: {args.music}")
    if args.wordmark and not args.wordmark.is_file():
        parser.error(f"wordmark not found: {args.wordmark}")
    clips_needed = dict.fromkeys(
        [
            "opener.mp4",
            *(shot.file for shot in SHOTS + RESULT),
            *(row[0] for row in PARALLEL),
        ]
    )
    missing = [name for name in clips_needed if not (args.footage / name).is_file()]
    if missing:
        parser.error("missing footage: " + ", ".join(missing))
    with tempfile.TemporaryDirectory(prefix="t3stash-launch-") as temp:
        temp = Path(temp)
        clips = []
        plate = temp / "plate.png"

        def clip_path():
            path = temp / f"{len(clips):02}.mp4"
            clips.append(path)
            return path

        ffmpeg(
            "-i",
            args.footage / "opener.mp4",
            "-vf",
            f"scale=1920:1080,setsar=1,tpad=stop_mode=clone:stop_duration={REVEAL_AT}",
            "-t",
            REVEAL_AT,
            *ENCODE,
            clip_path(),
        )
        title_card("intro").save(plate)
        still(plate, clip_path(), REVEAL_LENGTH)

        def shots(sequence):
            for shot in sequence:
                print(shot.section, shot.caption, flush=True)
                shot_card(shot).save(plate)
                footage(shot, args.footage, plate, clip_path())

        shots(SHOTS)
        parallel(args.footage, plate, clip_path())
        shots(RESULT)
        title_card("camera").save(plate)
        still(plate, clip_path(), CAMERA_LENGTH)
        title_card("cta", args.wordmark).save(plate)
        still(plate, clip_path(), CTA_LENGTH)
        program = temp / "program.txt"
        program.write_text(
            "".join(f"file {clip.name}\n" for clip in clips), encoding="utf-8"
        )
        cta_at = (
            REVEAL_AT
            + REVEAL_LENGTH
            + PARALLEL_LENGTH
            + CAMERA_LENGTH
            + sum(s.length for s in SHOTS + RESULT)
        )
        length = cta_at + CTA_LENGTH
        audio = temp / "sound.wav"
        sound(audio, length, REVEAL_AT, cta_at)
        if args.music:
            music = [
                "-ss",
                args.music_start,
                "-i",
                args.music,
                "-filter_complex",
                f"[2:a]aresample=48000,volume=0.48,afade=t=in:d=0.08,"
                f"afade=t=out:st={length - REVEAL_AT - 1.4}:d=1.4,"
                f"adelay={REVEAL_AT * 1000}:all=1[music];"
                "[1:a]aformat=sample_rates=48000:channel_layouts=stereo[sfx];"
                "[sfx][music]amix=inputs=2:duration=first:normalize=0[a]",
                "-map",
                "0:v",
                "-map",
                "[a]",
            ]
        else:
            music = ["-map", "0:v", "-map", "1:a"]
        ffmpeg(
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            program,
            "-i",
            audio,
            *music,
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            "-shortest",
            args.output,
        )


if __name__ == "__main__":
    main()
