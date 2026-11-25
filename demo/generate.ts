import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoBackup, demoPhotoName } from './fixture';

const dir = join('.cache', 'demo-backup');
mkdirSync(join(dir, 'media'), { recursive: true });
const photo = readFileSync(join('demo', 'assets', 'sedan.png'));
const manifest = demoBackup(Date.now(), { size: photo.length, md5: createHash('md5').update(photo).digest('hex') });
writeFileSync(join(dir, 'media', demoPhotoName), photo);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(dir);
