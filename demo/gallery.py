"""Refresh the README galleries from reviewed, publication-ready captures."""
import argparse
from pathlib import Path
import runpy

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument('--reviewed', action='store_true', help='Confirm manual privacy review of the published captures.')
if not parser.parse_args().reviewed:
    parser.error('Review the captures before using --reviewed.')

root = Path(__file__).resolve().parents[1]
frames = (
    ("home-dark", "Главная и план дня", "Dashboard and agenda"),
    ("vehicles-dark", "Автомобили и фильтры", "Vehicle list and filters"),
    ("vehicle-photos-dark", "Карточка и фотографии", "Vehicle card and photos"),
    ("history-dark", "Заметки и история", "Notes and vehicle timeline"),
    ("tasks-dark", "Активные задачи", "Active tasks"),
    ("task-edit-dark", "Сроки и повторения", "Scheduling and recurrence"),
    ("archive-dark", "Архив автомобилей", "Vehicle archive"),
    ("home-light", "Главная в светлой теме", "Dashboard in light mode"),
    ("notifications-dark", "Настройки уведомлений", "Notification settings"),
    ("backup-dark", "Экспорт и восстановление", "Backup and restore"),
)
for name, _, _ in frames:
    file = root / 'docs' / 'screenshots' / (name + '.png')
    with Image.open(file) as picture:
        if picture.format != 'PNG' or picture.width < 320 or picture.height <= picture.width or picture.info:
            raise SystemExit('Expected a metadata-free portrait PNG: ' + file.name)
        picture.verify()

start = '<!-- showcase-gallery:start -->'
stop = '<!-- showcase-gallery:end -->'
updates = {}
for filename, language in [('README.md', 1), ('README.en.md', 2)]:
    path = root / filename
    source = path.read_text(encoding='utf-8')
    if source.count(start) != 1 or source.count(stop) != 1:
        raise SystemExit('Gallery markers missing in ' + filename)
    before, rest = source.split(start)
    _, after = rest.split(stop)
    rows = ['| | |', '|---|---|']
    for index in range(0, len(frames), 2):
        cells = []
        for frame in frames[index:index + 2]:
            label = frame[language]
            image = f'docs/screenshots/{frame[0]}.png'
            cells.append(f'<strong>{label}</strong><br><a href="{image}"><img src="{image}" alt="{label}" width="255"></a>')
        rows.append('| ' + ' | '.join(cells) + ' |')
    updates[path] = before + start + '\n\n' + '\n'.join(rows) + '\n\n' + stop + after

runpy.run_path(str(root / 'demo' / 'banner.py'))
for path, source in updates.items():
    path.write_text(source, encoding='utf-8', newline='\n')
