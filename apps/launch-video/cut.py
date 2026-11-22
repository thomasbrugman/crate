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
MARK = Path(__file__).resolve().parents[2] / "assets/prod/black-universal-1024.png"
REPO = "github.com/thomasbrugman/t3stash"
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
    note: str = "LIVE T3STASH"


SHOTS = (
    Shot(
        "onboarding.mp4",
        2.6,
        "01 / CONNECT",
        "Connect your agent once.",
        0.1,
        0.45,
        (820, 580, 308, 72),
    ),
    Shot(
        "stage.mp4",
        3.8,
        "02 / PREPARE",
        "Set up the repo on a large Box.",
        0.5,
        1,
        (1220, 580, 32, 42),
        "UPSTASH BOX SDK LOG",
    ),
    Shot(
        "snapshot-setting.mp4",
        3.4,
        "02 / PREPARE",
        "Use that snapshot for new threads.",
        4.7,
        0.72,
        (890, 280, 388, 491),
    ),
    Shot(
        "box-size.mp4",
        2.8,
        "03 / START A THREAD",
        "Pick a Box size for the job.",
        0.15,
        0.83,
        (790, 325, 366, 226),
    ),
    Shot(
        "readme.mp4",
        3.5,
        "03 / START A THREAD",
        "Give the agent a task.",
        2.0,
        1.37,
        (1040, 486, 238, 148),
    ),
    Shot(
        "readme.mp4",
        3.1,
        "03 / START A THREAD",
        "t3stash starts its own Box.",
        6.6,
        5.5,
        (810, 438, 345, 65),
        "SETUP SPED UP",
    ),
    Shot(
        "install.mp4",
        2.5,
        "04 / RUN IN PARALLEL",
        "Start a second job while it works.",
        2.0,
        2.5,
        note="FOOTAGE SPED UP",
    ),
    Shot(
        "phone.mp4",
        2.6,
        "04 / RUN IN PARALLEL",
        "And a third.",
        2.0,
        2.7,
        note="FOOTAGE SPED UP",
    ),
    Shot(
        "inventory.mp4",
        4.2,
        "04 / RUN IN PARALLEL",
        "Three tasks. Three separate machines.",
        0.5,
        1,
        (1220, 580, 32, 42),
        "LIVE UPSTASH BOX SDK",
    ),
    Shot(
        "return-to-readme.mp4",
        2.1,
        "05 / CHECK THE WORK",
        "Come back to the first thread.",
        0.0,
        1,
    ),
    Shot(
        "result.mp4",
        5.2,
        "05 / CHECK THE WORK",
        "The README edit, straight from the Box.",
        0,
        1,
        (800, 326, 360, 165),
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
    gradient = Image.new("RGB", (192, 108))
    gradient.putdata(
        [
            (v, v, v + 2)
            for y in range(108)
            for x in range(192)
            for v in [
                9 + round(13 * max(0, 1 - math.hypot((x - 96) / 145, (y - 32) / 88)))
            ]
        ]
    )
    return gradient.resize((WIDTH, HEIGHT), Image.Resampling.BICUBIC)


def center(draw, text, y, size, color="#f4f3f1", kind="sans"):
    draw.text((WIDTH // 2, y), text, anchor="mm", font=font(size, kind), fill=color)


def title_card(kind):
    card = canvas()
    draw = ImageDraw.Draw(card)
    if kind == "camera":
        draw.rectangle((395, 220, 1525, 745), outline="#4a4a50", width=2)
        center(draw, "CAMERA INSERT", 364, 23, "#aaaab1", "mono")
        center(draw, "Close the lid. Check your phone.", 474, 52, kind="bold")
        center(draw, "Thomas’s shot goes here", 560, 32, "#babac0")
        center(
            draw,
            "Phone access needs an awake, reachable t3stash host.",
            873,
            32,
            "#d2d1d1",
        )
        return card

    logo = Image.open(MARK).convert("RGBA").resize((120, 120), Image.Resampling.LANCZOS)
    card.paste(logo, ((WIDTH - 120) // 2, 288), logo)
    center(draw, "t3stash", 522, 146, kind="bold")
    if kind == "intro":
        center(
            draw, "T3 Code threads run in their own cloud Boxes.", 662, 43, "#d7d6d3"
        )
    else:
        center(draw, REPO, 668, 43, kind="mono")
        center(draw, "Built on T3 Code and Upstash Box.", 854, 27, "#a5a4a8")
    return card


def shot_card(shot):
    card = canvas()
    draw = ImageDraw.Draw(card)
    draw.text(
        (88, 65), shot.section, anchor="lm", font=font(24, "mono"), fill="#d4d3d0"
    )
    draw.text((1832, 65), shot.note, anchor="rm", font=font(21, "mono"), fill="#a5a4a8")
    draw.rectangle((87, 113, 1832, 882), fill="#070708", outline="#333338", width=2)
    draw.text(
        (88, 970), shot.caption, anchor="lm", font=font(50, "bold"), fill="#f4f3f1"
    )
    return card


def still(image, output, length):
    ffmpeg("-loop", "1", "-framerate", FPS, "-i", image, "-t", length, *ENCODE, output)


def footage(shot, inputs, plate, output):
    path = inputs / shot.file
    crop = "" if shot.crop is None else f"crop={':'.join(map(str, shot.crop))},"
    frames = round(shot.length * FPS)
    graph = (
        f"[0:v]{crop}setpts=(PTS-STARTPTS)/{shot.speed},fps={FPS},"
        f"tpad=stop_mode=clone:stop_duration={shot.length},"
        "scale=1742:766:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        "pad=1742:766:(ow-iw)/2:(oh-ih)/2:color=0x070708,setsar=1[screen];"
        "[1:v][screen]overlay=89:115[out]"
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
    args = parser.parse_args()
    missing = [
        name
        for name in dict.fromkeys(["opener.mp4", *(shot.file for shot in SHOTS)])
        if not (args.footage / name).is_file()
    ]
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
            "scale=1920:1080,setsar=1,tpad=stop_mode=clone:stop_duration=7",
            "-t",
            7,
            *ENCODE,
            clip_path(),
        )
        title_card("intro").save(plate)
        still(plate, clip_path(), 3)
        for shot in SHOTS:
            print(shot.section, shot.caption, flush=True)
            shot_card(shot).save(plate)
            footage(shot, args.footage, plate, clip_path())
        title_card("camera").save(plate)
        still(plate, clip_path(), 6)
        title_card("cta").save(plate)
        still(plate, clip_path(), 5)
        program = temp / "program.txt"
        program.write_text(
            "".join(f"file {clip.name}\n" for clip in clips), encoding="utf-8"
        )
        cta_at = 16 + sum(s.length for s in SHOTS)
        audio = temp / "sound.wav"
        sound(audio, cta_at + 5, 7, cta_at)
        ffmpeg(
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            program,
            "-i",
            audio,
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
