import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const publicRoots = ['src', 'scripts', 'tests', 'docs', '.vibesync/dashboard.html',
  '.gitignore', '.mcp.example.json', 'package.json', 'package-lock.json',
  'README.md', 'HARDENING.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE'];
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['cloud access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['service token', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['credential in URL', /https?:\/\/[^\s/:]+:[^\s/@]+@/]
];
export function publicFiles(root) {
  const files = [];
  function visit(relative) {
    if (/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials\.json|service-account.*\.json)$|\.(?:pem|key|p12|pfx)$/i.test(relative)) throw new Error(`Private filename in public source: ${relative}`);
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Public export refuses symlink: ${relative}`);
    if (stat.isDirectory()) for (const child of fs.readdirSync(target)) visit(path.join(relative, child));
    else if (stat.isFile()) files.push(relative);
  }
  publicRoots.forEach(visit);
  return files;
}
export function checkPublic(root) {
  const files = publicFiles(root);
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [label, regex] of patterns) if (regex.test(text)) problems.push(`${file}: possible ${label}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return files;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.cwd();
    const files = checkPublic(root);
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const privateFiles = tracked.filter(file => fs.existsSync(path.join(root, file)) &&
      /^(?:\.agents\/|\.codex\/|\.local-archive\/|scratch\/|output\/|\.mcp\.json$|\.env(?:\.|$)|\.vibesync\/(?!dashboard\.html$)|blank\.pdf$|ORIGINAL_REQUEST\.md$)/.test(file));
    if (privateFiles.length) throw new Error(`Private/local files remain tracked:\n${privateFiles.join('\n')}`);
    console.log(`Public file check passed: ${files.length} files; no configured credential patterns found.`);
    console.log('This check does not erase or certify Git history. See docs/PUBLISHING.md.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
