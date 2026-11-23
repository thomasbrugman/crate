"""Crisp editorial labels anchored to the three visible workspace rows."""
from PIL import ImageDraw, ImageFont

BOX_LABELS = [('BOX 01', 'Phone pairing docs'),
              ('BOX 02', 'macOS install review'),
              ('BOX 03', 'Node version fix')]


def box_overlay(base, anchors, font_path):
    image = base.copy()
    draw = ImageDraw.Draw(image)
    heading = ImageFont.truetype(str(font_path), 46)
    heading.set_variation_by_axes([14, 600])
    detail = ImageFont.truetype(str(font_path), 30)
    for index, ((label, task), anchor) in enumerate(zip(BOX_LABELS, anchors)):
        y = 290 + index * 160
        x, ay = anchor
        draw.line([(x, ay), (1240, y+37), (1300, y+37)], fill='#727c8d', width=2)
        draw.ellipse((x-5, ay-5, x+5, ay+5), fill='#d3e2fa')
        draw.rounded_rectangle((1300, y, 1840, y+120), radius=12, fill='#101318ed',
                               outline='#414955', width=1)
        draw.text((1324, y+9), label, font=heading, fill='white')
        draw.text((1324, y+70), task, font=detail, fill='#bfc8d6')
    return image
