"""Assemble the t3stash launch cut from the staged opener and recorded footage."""

import argparse
import json
import math
from pathlib import Path
import random
import struct
import subprocess
import tempfile
import wave
from dataclasses import dataclass
from functools import cache

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT, FPS = 1920, 1080, 60
REPO = "github.com/thomasbrugman/t3stash"
REVEAL_AT = 7
REVEAL_LENGTH = 1.6
PHONE_LENGTH = 206 / FPS
MOBILE_README = "mobile-readme.mp4"
CTA_LENGTH = 3.6
SCREEN = (1696, 746)
PAPER = "#f1eee5"
INK = "#181815"
MUTED = "#5b574d"
ORANGE = "#ff7849"
RULE = "#bdb6a6"
READ_ME_ORDER = "TS-001"
BARCODE = (2, 4, 1, 3, 1, 2, 5, 2, 1, 4, 2, 3, 5, 1, 2, 3, 1, 4, 1, 2)
STAMP_AT = 0.64
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
        "02 / SETUP",
        "Connect your agent once.",
        0.1,
        crop=(800, 420, 320, 112),
        taps=(0.8,),
    ),
    Shot(
        "snapshot-setting.mp4",
        94 / FPS,
        "02 / SETUP",
        "Start new threads from a prepared snapshot.",
        0.42,
        crop=(920, 270, 374, 513),
    ),
    Shot(
        "box-size.mp4",
        112 / FPS,
        "03 / ROUTE",
        "Pick a Box size.",
        0.45,
        crop=(820, 336, 340, 251),
        taps=(0.28, 1.16),
    ),
    Shot(
        "readme.mp4",
        3.6,
        "03 / ROUTE",
        "Send a task to its own Box.",
        1.18,
        1.55,
        crop=(848, 390, 326, 208),
        note="FOOTAGE SPED UP",
        taps=(2.4,),
        pan_y=(16, 2.38),
    ),
)
PARALLEL_LENGTH = 3.9
PARALLEL = (
    ("readme.mp4", 5.52, "README edit"),
    ("install.mp4", 5.67, "Install review"),
    ("phone.mp4", 4.97, "Phone pairing"),
)
RESULT = (
    Shot(
        "recut-workspace.mp4",
        3.6,
        "05 / DELIVERY",
        "Switch between threads.",
        0.85,
        1.14,
        note="FOOTAGE SPED UP",
    ),
    Shot(
        "recut-workspace.mp4",
        178 / FPS,
        "05 / DELIVERY",
        "The README diff is back.",
        5.35,
        crop=(800, 244, 354, 185),
    ),
)


def ffmpeg(*args):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)],
        check=True,
    )


def video_stream(path, fields):
    return json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                f"stream={fields}",
                "-of",
                "json",
                path,
            ],
            text=True,
        )
    )["streams"][0]


@cache
def font(size, kind="sans"):
    name = {
        "sans": "DejaVuSans.ttf",
        "bold": "DejaVuSans-Bold.ttf",
        "mono": "DejaVuSansMono.ttf",
    }[kind]
    return ImageFont.truetype(name, size)


@cache
def stock(color):
    paper = Image.new("RGB", (WIDTH, HEIGHT), color)
    tint = ImageDraw.Draw(paper)
    rgb = paper.getpixel((0, 0))
    for y in range(0, HEIGHT, 5):
        tint.line((0, y, WIDTH, y), fill=tuple(max(v - 4, 0) for v in rgb))
    return paper


def waybill(draw, x, y, identifier, title, color=ORANGE):
    draw.rectangle((x, y, x + 300, y + 118), fill=color, outline=INK, width=2)
    draw.text(
        (x + 15, y + 14), "WORK ORDER / " + identifier, font=font(17, "mono"), fill=INK
    )
    draw.line((x + 15, y + 39, x + 285, y + 39), fill=INK)
    draw.text((x + 15, y + 49), title, font=font(27, "bold"), fill=INK)
    b = x + 15
    for unit in BARCODE:
        draw.rectangle((b, y + 87, b + unit * 2 - 1, y + 102), fill=INK)
        b += unit * 2 + 2
    draw.text((x + 283, y + 95), "↗", anchor="rm", font=font(27, "bold"), fill=INK)


def dispatch_card(section, title=None, *, tracking=True, dark=False):
    card = stock(INK if dark else PAPER).copy()
    draw = ImageDraw.Draw(card)
    fg = PAPER if dark else INK
    rule = "#625b4e" if dark else RULE
    draw.line((92, 113, 1828, 113), fill=rule, width=2)
    draw.line((92, 966, 1828, 966), fill=rule, width=2)
    draw.text((92, 77), section, anchor="lm", font=font(27, "mono"), fill=fg)
    draw.text((1828, 77), "T3STASH / DISPATCH", anchor="rm", font=font(24, "mono"), fill=fg)
    if title:
        draw.text((92, 154), title, anchor="lt", font=font(50, "bold"), fill=fg)
    if tracking:
        draw.rectangle((92, 989, 334, 1034), fill=ORANGE)
        draw.text(
            (108, 1012),
            "TRACKING / " + READ_ME_ORDER,
            anchor="lm",
            font=font(19, "mono"),
            fill=INK,
        )
    draw.text(
        (1828, 1012), "T3 CODE × UPSTASH BOX", anchor="rm", font=font(21, "mono"), fill=fg
    )
    return card


def center(draw, text, y, size, color=INK, kind="sans"):
    draw.text((WIDTH // 2, y), text, anchor="mm", font=font(size, kind), fill=color)


def title_card(wordmark=None, music_credit=None):
    card = dispatch_card("07 / END OF ROUTE", tracking=False)
    draw = ImageDraw.Draw(card)
    if wordmark:
        with Image.open(wordmark) as source:
            logo = source.convert("RGBA")
        logo.thumbnail((780, 178), Image.Resampling.LANCZOS)
        card.paste(logo, ((WIDTH - logo.width) // 2, 453 - logo.height // 2), logo)
    else:
        center(draw, "t3stash", 453, 154, kind="bold")
    center(draw, "Get t3stash on GitHub", 550, 31, MUTED)
    draw.rectangle((572, 594, 1348, 682), fill=ORANGE)
    center(draw, REPO, 638, 34, kind="mono")
    center(draw, "Built on T3 Code and Upstash Box.", 755, 31, MUTED)
    if music_credit:
        center(draw, music_credit, 895, 24, MUTED)
    return card


def shot_card(shot):
    card = dispatch_card(shot.section, shot.caption)
    draw = ImageDraw.Draw(card)
    if shot.note:
        draw.text((1828, 176), shot.note, anchor="rm", font=font(20, "mono"), fill=MUTED)
    return card


def still(image, output, length):
    ffmpeg(
        "-loop",
        "1",
        "-framerate",
        FPS,
        "-i",
        image,
        "-frames:v",
        round(length * FPS),
        *ENCODE,
        output,
    )


def easing(t, seconds):
    return f"(1-cos(PI*clip(({t})/{seconds},0,1)))/2"


def footage(shot, inputs, plate, output, *, delivered=False):
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
    arrival = easing("t", 0.55)
    departure = easing(f"t-{shot.length - 0.24}", 0.24)
    graph = (
        f"[0:v]setpts=(PTS-STARTPTS)/{shot.speed},fps={FPS},{crop}"
        f"tpad=stop_mode=clone:stop_duration={shot.length},"
        f"scale={width * 2}:{height * 2},"
        f"zoompan=z='1+0.10*(1-cos(PI*min(on/{frames - 1},1)))/2':"
        f"x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s={width}x{height}:fps={FPS},"
        "setsar=1,drawbox=c=0xa7a293:w=iw:h=ih:t=2[screen];"
        f"[1:v][screen]overlay=x='(W-w)/2+96*(1-{arrival})-64*{departure}':y=589-h/2"
    )
    stamp_input = []
    if delivered:
        stamp = Image.new("RGBA", (415, 111))
        draw = ImageDraw.Draw(stamp)
        draw.rectangle((4, 4, 410, 106), fill=ORANGE, outline=INK, width=4)
        draw.rectangle((12, 12, 402, 98), outline=INK, width=2)
        draw.text((205, 57), "DELIVERED", anchor="mm", font=font(52, "bold"), fill=INK)
        stamp_path = plate.with_name("delivered.png")
        stamp.rotate(5, resample=Image.Resampling.BICUBIC, expand=True).save(stamp_path)
        stamp_input = ["-loop", "1", "-framerate", FPS, "-i", stamp_path]
        graph += (
            "[base];[base][2:v]overlay="
            f"x=1328:y='834+22*pow(max(0,1-(t-{STAMP_AT})/0.12),2)':"
            f"enable='gte(t,{STAMP_AT})'"
        )
    graph += "[out]"
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
        *stamp_input,
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
    card = dispatch_card(
        "04 / IN TRANSIT", "Three jobs. Three separate Boxes.", dark=True
    )
    args = ["-loop", "1", "-framerate", FPS, "-i", plate]
    graph = []
    row_width, row_height = 1736, 222
    for i, (name, start, label) in enumerate(PARALLEL):
        delay = i * 0.64
        y = 229 + i * 242
        row = Image.new("RGB", (row_width, row_height), "#282822")
        draw = ImageDraw.Draw(row)
        draw.rectangle(
            (0, 0, row_width - 1, row_height - 1), outline="#625b4e", width=2
        )
        waybill(draw, 40, 50, f"TS-{i + 1:03}", label, ORANGE if i == 0 else PAPER)
        draw.text((430, 108), "→", anchor="mm", font=font(52, "bold"), fill=PAPER)
        draw.text(
            (1628, 109),
            f"BOX 0{i + 1}",
            anchor="mm",
            font=font(23, "mono"),
            fill=ORANGE if i == 0 else PAPER,
        )
        row_path = plate.with_name(f"dock-{i}.png")
        row.save(row_path)
        args += ["-loop", "1", "-framerate", FPS, "-i", row_path]
        args += ["-ss", start, "-i", inputs / name]
        graph.append(
            f"[{2 * i + 2}:v]crop=1116:284:252:62,scale=856:218,fps={FPS},setsar=1,"
            "drawbox=c=0xc9c7c2:w=iw:h=ih:t=2,"
            f"tpad=stop_mode=clone:stop_duration={PARALLEL_LENGTH}[clip{i}];"
            f"[{2 * i + 1}:v][clip{i}]overlay=527:2:shortest=1[dock{i}]"
        )
        base = "0:v" if i == 0 else f"row{i - 1}"
        graph.append(
            f"[{base}][dock{i}]overlay=x='92+552*(1-{easing(f't-{delay}', 0.71)})':"
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
    path = inputs / MOBILE_README
    dimensions = video_stream(path, "width,height")
    source_width, source_height = dimensions["width"], dimensions["height"]
    scale = min(500 / source_width, 784 / source_height)
    width, height = (2 * round(d * scale / 2) for d in (source_width, source_height))
    x, y = 1330 - width // 2, 539 - height // 2
    card = dispatch_card("06 / HANDOFF")
    draw = ImageDraw.Draw(card)
    waybill(draw, 151, 286, READ_ME_ORDER, "README edit")
    draw.multiline_text(
        (151, 460), "Same thread.\nNow on your phone.", font=font(67, "bold"), fill=INK
    )
    draw.multiline_text(
        (151, 675),
        "Phone access needs an awake,\nreachable t3stash host.",
        font=font(32),
        fill=MUTED,
    )
    card.save(plate)
    bezel = Image.new("RGBA", (width + 28, height + 28))
    ImageDraw.Draw(bezel).rounded_rectangle(
        (0, 0, width + 27, height + 27), radius=40, fill="#252525"
    )
    bezel_path = plate.with_name("phone-bezel.png")
    bezel.save(bezel_path)
    mask = Image.new("L", (width, height))
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, width - 1, height - 1), radius=28, fill=255
    )
    mask_path = plate.with_name("phone-mask.png")
    mask.save(mask_path)
    ffmpeg(
        "-i",
        path,
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
        "-loop",
        "1",
        "-framerate",
        FPS,
        "-i",
        bezel_path,
        "-filter_complex_threads",
        1,
        "-filter_complex",
        f"[0:v]scale={width}:{height},setsar=1,fps={FPS},"
        f"tpad=stop_mode=clone:stop_duration={PHONE_LENGTH}[capture];"
        "[capture][2:v]alphamerge[screen];"
        "[3:v][screen]overlay=14:14:format=auto[phone];"
        f"[1:v][phone]overlay=x='{x - 14}+224*(1-{easing('t', 0.66)})':y={y - 14}[out]",
        "-map",
        "[out]",
        "-frames:v",
        round(PHONE_LENGTH * FPS),
        *ENCODE,
        output,
    )


def sound(output, length, title_at, stamp_at, cta_at, taps):
    rate = 24000
    rng = random.Random(24)
    low_noise = 0.0
    samples = bytearray()
    jam_at = 2
    for i in range(round(rate * length)):
        t = i / rate
        low_noise = 0.92 * low_noise + 0.08 * rng.uniform(-1, 1)
        fan = 0.0
        if t < jam_at:
            ramp = min(1, t / 0.7) * min(1, (jam_at - t) / 0.04)
            fan = (
                ramp
                * (0.018 + 0.04 * t / jam_at)
                * (2.8 * low_noise + math.sin(2 * math.pi * (64 * t + 2.2 * t * t)))
            )
        cue = 0.0
        for when in (0.40, 0.73, 1.07, 1.40, title_at - 0.17):
            age = t - when
            if 0 <= age < 0.26:
                cue += (
                    0.15
                    * min(1, age * 250)
                    * math.exp(-14 * age)
                    * (
                        3 * low_noise
                        + 0.45 * math.sin(2 * math.pi * (310 * age + 125 * age * age))
                    )
                )
        for when, root, gain in (
            (jam_at, 76, 0.16),
            (title_at, 55, 0.17),
            (stamp_at, 92, 0.18),
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
    intro_length = REVEAL_AT + REVEAL_LENGTH
    intro_frames = round(intro_length * FPS)
    opener = video_stream(args.footage / "opener.mp4", "avg_frame_rate,nb_frames")
    if (
        opener.get("avg_frame_rate") != f"{FPS}/1"
        or opener.get("nb_frames") != str(intro_frames)
    ):
        parser.error(
            f"re-render opener.mp4 (expected {intro_frames} frames at {FPS} fps)"
        )
    with tempfile.TemporaryDirectory(prefix="t3stash-launch-") as temp:
        temp = Path(temp)
        clips = []
        plate = temp / "plate.png"

        def clip_path(length):
            path = temp / f"{len(clips):02}.mp4"
            clips.append((path, round(length * FPS)))
            return path

        ffmpeg(
            "-i",
            args.footage / "opener.mp4",
            "-vf",
            f"scale={WIDTH}:{HEIGHT},setsar=1",
            "-frames:v",
            intro_frames,
            *ENCODE,
            clip_path(intro_length),
        )

        def shots(sequence, *, final_delivery=False):
            for i, shot in enumerate(sequence):
                print(shot.section, shot.caption, flush=True)
                shot_card(shot).save(plate)
                footage(
                    shot,
                    args.footage,
                    plate,
                    clip_path(shot.length),
                    delivered=final_delivery and i == len(sequence) - 1,
                )

        shots(SHOTS)
        parallel(args.footage, plate, clip_path(PARALLEL_LENGTH))
        shots(RESULT, final_delivery=True)
        phone_handoff(args.footage, plate, clip_path(PHONE_LENGTH))
        title_card(args.wordmark, args.music_credit).save(plate)
        still(plate, clip_path(CTA_LENGTH), CTA_LENGTH)
        program = temp / "program.txt"
        program.write_text(
            "".join(
                f"file {path.name}\nduration {frames / FPS:.6f}\n"
                for path, frames in clips
            ),
            encoding="utf-8",
        )
        elapsed = intro_length
        taps = [2.47]
        for shot in SHOTS:
            taps.extend(elapsed + offset for offset in shot.taps)
            elapsed += shot.length
        cta_at = (
            elapsed + PARALLEL_LENGTH + sum(s.length for s in RESULT) + PHONE_LENGTH
        )
        diff_at = cta_at - PHONE_LENGTH - RESULT[-1].length
        length = cta_at + CTA_LENGTH
        audio = temp / "sound.wav"
        sound(audio, length, REVEAL_AT, diff_at + STAMP_AT, cta_at, taps)
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
            music = ["-map", "0:v", "-map", "1:a", "-ac", "2"]
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
