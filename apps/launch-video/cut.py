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
REVEAL_LENGTH = 1.6
PHONE_LENGTH = 103 / FPS
MOBILE_README = "mobile-readme.mp4"
CTA_LENGTH = 3.6
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
    taps: tuple[float, ...] = ()
    pan_y: tuple[int, float] | None = None


SHOTS = (
    Shot(
        "onboarding.mp4",
        2.5,
        "CONNECT",
        "Connect your agent once.",
        0.1,
        crop=(800, 610, 320, 115),
        taps=(0.74,),
    ),
    Shot(
        "snapshot-setting.mp4",
        47 / FPS,
        "PREPARE",
        "Start new threads from a prepared snapshot.",
        3.6,
        crop=(870, 252, 404, 526),
    ),
    Shot(
        "box-size.mp4",
        56 / FPS,
        "START A THREAD",
        "Pick a Box size.",
        0.85,
        1.3,
        crop=(680, 330, 407, 263),
        taps=(0.31, 1.61),
    ),
    Shot(
        "readme.mp4",
        3.6,
        "START A THREAD",
        "Send a task to its own Box.",
        2.1,
        1.55,
        crop=(830, 340, 332, 225),
        note="FOOTAGE SPED UP",
        taps=(2.45,),
        pan_y=(34, 2.43),
    ),
)
PARALLEL_LENGTH = 3.9
PARALLEL = (
    ("readme.mp4", 6.25, "README edit"),
    ("install.mp4", 5.0, "Install review"),
    ("phone.mp4", 4.35, "Phone pairing"),
)
RESULT = (
    Shot(
        "recut-workspace.mp4",
        3.6,
        "CHECK THE WORK",
        "Switch between threads.",
        1.3,
        2.3,
        note="FOOTAGE SPED UP",
    ),
    Shot(
        "recut-workspace.mp4",
        89 / FPS,
        "CHECK THE WORK",
        "The README diff, straight from the Box.",
        11.3,
        crop=(820, 280, 346, 165),
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


def title_card(kind, wordmark=None, music_credit=None):
    card = canvas()
    draw = ImageDraw.Draw(card)
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
        center(draw, "Get it on GitHub", 607, 30, MUTED)
        center(draw, REPO, 668, 43, kind="mono")
        center(draw, "Built on T3 Code and Upstash Box.", 854, 29, MUTED)
        if music_credit:
            center(draw, music_credit, 955, 24, MUTED)
    return card


def shot_card(shot):
    card = canvas()
    draw = ImageDraw.Draw(card)
    if shot.note:
        draw.text((1792, 46), shot.note, anchor="rm", font=font(21, "mono"), fill=MUTED)
    draw.text((960, 1022), shot.caption, anchor="mm", font=font(49, "bold"), fill=INK)
    return card


def still(image, output, length, *, filters=""):
    vf = ["-vf", filters] if filters else []
    ffmpeg(
        "-loop",
        "1",
        "-framerate",
        FPS,
        "-i",
        image,
        *vf,
        "-frames:v",
        round(length * FPS),
        *ENCODE,
        output,
    )


def footage(shot, inputs, plate, output):
    path = inputs / shot.file
    frames = round(shot.length * FPS)
    crop = ""
    if shot.crop:
        width, height, x, y = shot.crop
        if shot.pan_y:
            end_y, at = shot.pan_y
            y = f"'{y}+({end_y - y})*(1-cos(PI*clip((t-{at})/0.23,0,1)))/2'"
        crop = f"crop={width}:{height}:{x}:{y},"
    else:
        width, height = 1440, 810
    scale = min(SCREEN[0] / width, SCREEN[1] / height)
    width, height = (2 * round(d * scale / 2) for d in (width, height))
    graph = (
        f"[0:v]setpts=(PTS-STARTPTS)/{shot.speed},fps={FPS},{crop}"
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
        )
    )
    draw = ImageDraw.Draw(card)
    args = ["-loop", "1", "-framerate", FPS, "-i", plate]
    graph = []
    for i, (name, start, label) in enumerate(PARALLEL):
        delay = i * 0.42
        x, y = 460 + i * 165, 170 + i * 258
        draw.rounded_rectangle(
            (x - 310, y + 80, x - 24, y + 148),
            radius=18,
            fill="#e3e1db",
        )
        draw.text(
            (x - 43, y + 114),
            label,
            anchor="rm",
            font=font(32, "bold"),
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


def phone_handoff(inputs, plate, output):
    x, y, width, height = 1090, 99, 480, 882
    card = canvas()
    draw = ImageDraw.Draw(card)
    draw.multiline_text(
        (250, 405), "Same thread.\nNow on your phone.", font=font(67, "bold"), fill=INK
    )
    draw.multiline_text(
        (250, 632),
        "Phone access needs an awake,\nreachable t3stash host.",
        font=font(32),
        fill=MUTED,
    )
    draw.rounded_rectangle(
        (x - 14, y - 14, x + width + 13, y + height + 13), radius=40, fill="#252525"
    )
    card.save(plate)
    mask = Image.new("L", (width, height))
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, width - 1, height - 1), radius=28, fill=255
    )
    mask_path = plate.with_name("phone-mask.png")
    mask.save(mask_path)
    ffmpeg(
        "-i",
        inputs / MOBILE_README,
        "-loop",
        "1",
        "-framerate",
        FPS,
        "-i",
        plate,
        "-loop",
        "1",
        "-framerate",
        FPS,
        "-i",
        mask_path,
        "-filter_complex_threads",
        1,
        "-filter_complex",
        f"[0:v]scale={width}:{height},setsar=1,fps={FPS},"
        f"tpad=stop_mode=clone:stop_duration={PHONE_LENGTH}[capture];"
        f"[capture][2:v]alphamerge[phone];[1:v][phone]overlay={x}:{y}[out]",
        "-map",
        "[out]",
        "-frames:v",
        round(PHONE_LENGTH * FPS),
        *ENCODE,
        output,
    )


def sound(output, length, title_at, diff_at, cta_at, taps):
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
        for when, root, gain in (
            (title_at, 55, 0.17),
            (diff_at, 330, 0.045),
            (cta_at, 165, 0.07),
        ):
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
        for when in taps:
            age = t - when
            if 0 <= age < 0.055:
                cue += (
                    0.19
                    * min(1, age * 850)
                    * math.exp(-95 * age)
                    * (math.sin(2 * math.pi * 1350 * age) + 0.4 * low_noise)
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
    parser.add_argument("--music-credit", help="Short music credit for the end card")
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
    if args.music_credit and not args.music:
        parser.error("--music-credit requires --music")
    if args.wordmark and not args.wordmark.is_file():
        parser.error(f"wordmark not found: {args.wordmark}")
    clips_needed = dict.fromkeys(
        [
            "opener.mp4",
            MOBILE_README,
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
        still(
            plate, clip_path(), REVEAL_LENGTH, filters="fade=t=in:d=0.23:color=0x131313"
        )

        def shots(sequence):
            for shot in sequence:
                print(shot.section, shot.caption, flush=True)
                shot_card(shot).save(plate)
                footage(shot, args.footage, plate, clip_path())

        shots(SHOTS)
        parallel(args.footage, plate, clip_path())
        shots(RESULT)
        phone_handoff(args.footage, plate, clip_path())
        title_card("cta", args.wordmark, args.music_credit).save(plate)
        still(
            plate,
            clip_path(),
            CTA_LENGTH,
            filters=(
                "scale=3840:2160,zoompan=z='1+0.035*pow(max(1-on/14,0),3)':"
                f"x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={WIDTH}x{HEIGHT}:fps={FPS},"
                "setsar=1"
            ),
        )
        program = temp / "program.txt"
        program.write_text(
            "".join(f"file {clip.name}\n" for clip in clips), encoding="utf-8"
        )
        elapsed = REVEAL_AT + REVEAL_LENGTH
        taps = [74 / FPS]
        for shot in SHOTS:
            taps.extend(elapsed + offset for offset in shot.taps)
            elapsed += shot.length
        cta_at = (
            elapsed + PARALLEL_LENGTH + sum(s.length for s in RESULT) + PHONE_LENGTH
        )
        diff_at = cta_at - PHONE_LENGTH - RESULT[-1].length
        length = cta_at + CTA_LENGTH
        audio = temp / "sound.wav"
        sound(audio, length, REVEAL_AT, diff_at, cta_at, taps)
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
