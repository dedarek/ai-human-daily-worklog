import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir(new URL('../lib/', import.meta.url), { recursive: true });
const value = randomBytes(32).toString('hex');
await writeFile(new URL('../lib/generated-key.js', import.meta.url), `export const DEPLOYMENT_KEY = ${JSON.stringify(value)};\n`, 'utf8');
console.log('Generated deployment-scoped Worklog key.');
