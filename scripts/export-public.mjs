import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublic } from './check-public.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function exportPublicSource(sourceRoot, destinationPath) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationPath);
  if (destination === source || destination.startsWith(source + path.sep)) {
    throw new Error('Destination must be outside the source checkout.');
  }
  if (fs.existsSync(destination)) throw new Error('Destination already exists; choose a new path.');
  const files = checkPublic(source);
  fs.mkdirSync(destination, { recursive: false });
  try {
    for (const file of files) {
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, file), target, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(target, fs.statSync(path.join(source, file)).mode & 0o777);
    }
    return files;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: node scripts/export-public.mjs /path/to/new-public-folder');
  const files = exportPublicSource(root, argument);
  console.log(`Exported ${files.length} public files to ${path.resolve(argument)}. No Git history or local runtime state was copied.`);
}
