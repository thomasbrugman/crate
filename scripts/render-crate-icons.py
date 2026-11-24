#!/usr/bin/env python3
import argparse
import io
import json
from pathlib import Path

import cairosvg
from PIL import Image, ImageChops, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/prod/logo.svg"
VARIANTS = {"dev": ("blueprint", "blueprint"), "nightly": ("nightly", "nightly"), "prod": ("black", "t3-black")}
ICO_SIZES = [(n, n) for n in (16, 24, 32, 48, 64, 128, 256)]


def render(svg, size):
    png = cairosvg.svg2png(bytestring=svg, output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def centered(image, size, background=None):
    canvas = Image.new("RGBA", (size, size), background)
    offset = (size - image.width) // 2
    canvas.alpha_composite(image, (offset, offset))
    return canvas


def write_icons(svg):
    for channel, (desktop, web) in VARIANTS.items():
        assets = ROOT / "assets" / channel
        composer = assets / "app-icon.icon"
        (composer / "Assets/box-buddy.svg").write_bytes(svg)
        config = json.loads((composer / "icon.json").read_text())
        config["fill"] = {"solid": "display-p3:0.78824,0.55686,0.33333,1.00000"}
        config["groups"] = [{"layers": [{
            "glass": False,
            "image-name": "box-buddy.svg",
            "name": "Box Buddy",
            "position": {"scale": 2, "translation-in-points": [0, 0]},
        }]}]
        (composer / "icon.json").write_text(json.dumps(config, indent=2) + "\n")

        for platform in ("ios", "macos", "universal"):
            icon = centered(render(svg, 879), 1024) if platform == "macos" else render(svg, 1024)
            icon.save(assets / f"{desktop}-{platform}-1024.png")

        ico = render(svg, 256)
        ico.save(assets / f"{web}-windows.ico", sizes=ICO_SIZES)
        ico.save(assets / f"{web}-web-favicon.ico", sizes=ICO_SIZES)
        icons = {
            "favicon-16x16.png": ("favicon-16x16.png", 16),
            "favicon-32x32.png": ("favicon-32x32.png", 32),
            "apple-touch-icon.png": ("apple-touch-180.png", 180),
            "icon-192x192.png": ("icon-192x192.png", 192),
            "icon-512x512.png": ("icon-512x512.png", 512),
        }
        for public_name, (suffix, size) in icons.items():
            icon = render(svg, size)
            icon.save(assets / f"{web}-web-{suffix}")
            if channel == "dev":
                icon.save(ROOT / "apps/web/public" / public_name)
        if channel == "dev":
            ico.save(ROOT / "apps/web/public/favicon.ico", sizes=ICO_SIZES)


def write_wordmarks(svg, font_path):
    directory = ROOT / "assets/crate"
    directory.mkdir(exist_ok=True)
    font = ImageFont.truetype(str(font_path), size=186)
    mascot = render(svg, 192)
    for color, fill in (("black", "#171717"), ("white", "#fafafa")):
        wordmark = Image.new("RGBA", (1024, 213))
        draw = ImageDraw.Draw(wordmark)
        width = mascot.width + 30 + font.getlength("Crate")
        x = round((wordmark.width - width) / 2)
        wordmark.alpha_composite(mascot, (x, 10))
        draw.text((x + mascot.width + 30, 106), "Crate", font=font, fill=fill, anchor="lm")
        wordmark.save(directory / f"wordmark-{color}.png")


def write_android(svg):
    mobile = ROOT / "apps/mobile/assets"
    foreground = centered(render(svg, 250), 432)
    foreground.save(mobile / "android-icon-foreground.png")

    # Android masks monochrome icons with its own tint. Cut the dark details out of the silhouette.
    light = foreground.getchannel("R").point(lambda channel: 255 if channel >= 100 else 0)
    mask = ImageChops.multiply(foreground.getchannel("A"), light)
    monochrome = Image.new("RGBA", foreground.size, "white")
    monochrome.putalpha(mask)
    monochrome.save(mobile / "android-icon-mark.png")
    monochrome.resize((96, 96), Image.Resampling.LANCZOS).save(mobile / "android-notification-icon.png")

    for channel in VARIANTS:
        if channel == "prod":
            background = Image.new("RGBA", (1152, 1152), "#000000")
        else:
            background = Image.open(mobile / f"android-icon-background-{channel}.png").convert("RGBA")
            background = background.resize((1152, 1152), Image.Resampling.LANCZOS)
        background.alpha_composite(centered(render(svg, 667), 1152))
        background.save(mobile / f"android-splash-icon-{channel}.png")


def main():
    parser = argparse.ArgumentParser(description="Rasterize Crate’s canonical logo with CairoSVG.")
    parser.add_argument("--font", type=Path, default=Path.home() / ".fonts/Inter-Bold.ttf")
    args = parser.parse_args()
    svg = SOURCE.read_bytes()
    (ROOT / "apps/mobile/assets/widget/T3Mark.svg").write_bytes(svg)
    write_icons(svg)
    write_wordmarks(svg, args.font)
    write_android(svg)


if __name__ == "__main__":
    main()
