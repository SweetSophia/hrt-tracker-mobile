import { execFileSync } from 'node:child_process';

const probe = process.argv.includes('--probe');
const storage = process.argv.includes('--storage-qualification');
if (probe && storage) throw new Error('Choose one mobile qualification profile.');
const env = { ...process.env, HRT_MOBILE_PROBE: probe ? '1' : '0' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const build = storage ? 'build:mobile:storage' : probe ? 'build:mobile:probe' : 'build:mobile';
execFileSync(npm, ['run', build], { env, stdio: 'inherit' });
execFileSync(npm, ['exec', '--', 'cap', 'sync', 'android'], { env, stdio: 'inherit' });
