"""Compose the social preview from reviewed screenshots of the isolated emulator."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

docs = Path(__file__).resolve().parents[1] / 'docs'
files = [docs / 'screenshots' / name for name in ('vehicle-dark.png', 'tasks-dark.png')]
if not all(file.is_file() for file in files):
    raise SystemExit('Capture vehicle-dark.png and tasks-dark.png from the demo before composing the banner.')

canvas = Image.new('RGB', (1280, 640), '#101019')
draw = ImageDraw.Draw(canvas)
font_dir = Path('C:/Windows/Fonts')
title = ImageFont.truetype(str(font_dir / 'segoeuib.ttf'), 73)
subtitle = ImageFont.truetype(str(font_dir / 'segoeui.ttf'), 31)
draw.rectangle((76, 188, 142, 193), fill='#A291FF')
draw.text((74, 214), 'Auto CRM', font=title, fill='#F7F5FF')
draw.text((76, 320), 'Offline-first Android CRM', font=subtitle, fill='#C9C4DB')
for index, file in enumerate(files):
    with Image.open(file) as original:
        screenshot = original.convert('RGB')
        if screenshot.height <= screenshot.width:
            raise SystemExit('Use portrait Android captures.')
        screenshot.thumbnail((276, 540), Image.Resampling.LANCZOS)
        x = 640 + index * 304 + (276 - screenshot.width) // 2
        y = (640 - screenshot.height) // 2
        draw.rounded_rectangle((x - 3, y - 3, x + screenshot.width + 2, y + screenshot.height + 2),
                               radius=5, fill='#49415D')
        canvas.paste(screenshot, (x, y))
canvas.save(docs / 'banner.png', optimize=True)
