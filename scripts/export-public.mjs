import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublic } from './check-public.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argument = process.argv[2];
if (!argument) throw new Error('Usage: node scripts/export-public.mjs /path/to/new-public-folder');
const destination = path.resolve(argument);
if (fs.existsSync(destination)) throw new Error('Destination already exists; choose a new empty location.');
const files = checkPublic(root);
fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, fs.statSync(path.join(root, file)).mode & 0o777);
}
console.log(`Exported ${files.length} public files to ${destination}. No Git history or local runtime state was copied.`);
