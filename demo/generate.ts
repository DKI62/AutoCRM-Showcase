import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoBackup } from './fixture';

const dir = join('.cache', 'demo-backup');
mkdirSync(join(dir, 'media'), { recursive: true });
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(demoBackup(), null, 2) + '\n', 'utf8');
console.log(dir);
