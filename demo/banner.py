"""Compose a GitHub social preview from three approved Android captures."""
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

docs = Path(__file__).resolve().parents[1] / 'docs'
screens = [
    ('home-dark.png', 'Dashboard'),
    ('vehicles-dark.png', 'Vehicle list'),
    ('vehicle-photos-dark.png', 'Photo attachments'),
]

canvas = Image.new('RGB', (1280, 640), '#101017')
draw = ImageDraw.Draw(canvas)
fonts = Path('C:/Windows/Fonts')
title = ImageFont.truetype(str(fonts / 'segoeuib.ttf'), 70)
subtitle = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 28)
caption = ImageFont.truetype(str(fonts / 'segoeui.ttf'), 17)

draw.rounded_rectangle((64, 137, 110, 141), radius=2, fill='#A799FF')
draw.text((61, 162), 'AutoCRM', font=title, fill='#F7F5FF')
draw.text((61, 239), 'Showcase', font=title, fill='#F7F5FF')
draw.multiline_text((64, 355), 'Offline-first CRM for vehicle\nsourcing and follow-up', font=subtitle, fill='#C8C5D6', spacing=9)

for index, (name, label) in enumerate(screens):
    with Image.open(docs / 'screenshots' / name) as photo:
        frame = photo.convert('RGB')
        if frame.height <= frame.width:
            raise SystemExit('Expected a portrait capture: ' + name)
        frame.thumbnail((222, 464), Image.Resampling.LANCZOS)
        x = 511 + index * 241 + (222 - frame.width) // 2
        y = 72 + (464 - frame.height) // 2
        draw.rounded_rectangle((x - 4, y - 4, x + frame.width + 3, y + frame.height + 3),
                               radius=6, fill='#45405B')
        canvas.paste(frame, (x, y))
        draw.text((x + frame.width / 2, 558), label, anchor='mt', font=caption, fill='#C8C5D6')

result = BytesIO()
canvas.save(result, format='PNG', optimize=True)
if result.tell() >= 1_000_000:
    raise SystemExit('GitHub social preview must be smaller than 1 MB.')
(docs / 'banner.png').write_bytes(result.getvalue())
