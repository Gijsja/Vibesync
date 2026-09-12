#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpServer } from '../src/mcp.mjs';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const RECEIPT_FORMAT = 'vibesync-baseline-receipt/v1';
export const CANONICAL_SKILL = 'skills/vibesync-mcp/SKILL.md';
export const REQUIRED_PACKAGE_ASSETS = Object.freeze([
  'scripts/vibesync-baseline.mjs',
  'scripts/vibesync-bun-baseline.mjs',
  CANONICAL_SKILL,
  '.mcp.example.json',
  '.mcp.bun.example.json'
]);
export const CHECK_IDS = Object.freeze([
  'package',
  'cli_help',
  'mcp_catalogs',
  'canonical_skill',
  'mcp_configuration',
  'runtime_policy_docs'
]);

const scriptRoot = fileURLToPath(new URL('../', import.meta.url));
const normalize = value => value.split(path.sep).join('/');
const existing = target => fs.existsSync(target);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function filesUnder(root, relative) {
  const target = path.join(root, relative);
  if (!existing(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [normalize(relative)];
  return fs.readdirSync(target, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => filesUnder(root, path.join(relative, entry.name)));
}

export function packageFileList(repoRoot, packageJson = readJson(path.join(repoRoot, 'package.json'))) {
  return [...new Set((packageJson.files || []).flatMap(entry => filesUnder(repoRoot, entry)))].sort();
}

function assertIncludes(haystack, needles, label) {
  const missing = needles.filter(needle => !haystack.includes(needle));
  if (missing.length) throw new Error(`${label} missing: ${missing.join(', ')}`);
}

async function mcpToolNames(repoRoot, role) {
  // Catalog listing is declaration-only. A truthy inert handle prevents the
  // server factory from opening or mutating repository state during baseline.
  const server = createMcpServer({ db: Object.freeze({}), repoRoot, role });
  const list = server._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  if (!list) throw new Error(`Unable to inspect ${role} MCP catalog.`);
  const result = await list({ method: 'tools/list', params: {} });
  return result.tools.map(tool => tool.name).sort();
}

function checkPackage(repoRoot, context) {
  const packageJson = readJson(path.join(repoRoot, 'package.json'));
  const published = packageFileList(repoRoot, packageJson);
  assertIncludes(published, REQUIRED_PACKAGE_ASSETS, 'Published package');
  if (packageJson.bin?.['vibesync-baseline'] !== './scripts/vibesync-baseline.mjs') {
    throw new Error('package.json must expose the vibesync-baseline binary.');
  }
  if (!packageJson.scripts?.baseline || !packageJson.scripts?.['baseline:bun']) {
    throw new Error('package.json must expose baseline and baseline:bun scripts.');
  }
  context.packageJson = packageJson;
  context.published = published;
  return `${published.length} packaged files; ${REQUIRED_PACKAGE_ASSETS.length} required assets present`;
}

function checkCliHelp(repoRoot) {
  const entrypoint = typeof Bun === 'undefined' ? 'scripts/vibesync.mjs' : 'scripts/vibesync-bun.mjs';
  const help = execFileSync(process.execPath, [path.join(repoRoot, entrypoint), '--help'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 128 * 1024
  });
  assertIncludes(help, ['--mcp-role', '--agent-instructions', '--queue', '--handoff', '--eject'], 'CLI help');
  return `${typeof Bun === 'undefined' ? 'Node' : 'Bun'} CLI help exposes worker/admin role and operator workflow options`;
}

async function checkMcpCatalogs(repoRoot, context) {
  const worker = await mcpToolNames(repoRoot, 'worker');
  const admin = await mcpToolNames(repoRoot, 'admin');
  assertIncludes(worker, ['vibesync_list_ready_tasks', 'vibesync_preview_task', 'vibesync_claim_task',
    'vibesync_heartbeat_task', 'vibesync_partial_verify', 'vibesync_verify_and_settle'], 'Worker MCP catalog');
  assertIncludes(admin, ['vibesync_create_feature', 'vibesync_create_task', 'vibesync_approve_task_command',
    'vibesync_approve_feature_command', 'vibesync_release_task'], 'Admin MCP catalog');
  const overlap = worker.filter(name => admin.includes(name));
  if (overlap.length) throw new Error(`Worker/admin MCP catalogs overlap: ${overlap.join(', ')}`);
  context.tools = new Set([...worker, ...admin]);
  return `${worker.length} worker tools; ${admin.length} admin tools; role catalogs disjoint`;
}

function checkCanonicalSkill(repoRoot) {
  const file = path.join(repoRoot, CANONICAL_SKILL);
  if (!existing(file)) throw new Error(`Canonical skill missing: ${CANONICAL_SKILL}`);
  const text = fs.readFileSync(file, 'utf8');
  if (!/^---\s*$[\s\S]*?^name:\s*vibesync-mcp\s*$/m.test(text) ||
      !/^description:\s*\S.+$/m.test(text)) {
    throw new Error('Canonical skill metadata must declare name and description.');
  }
  assertIncludes(text, ['vibesync_preview_task', 'vibesync_claim_task', 'vibesync_verify_and_settle'], 'Canonical skill workflow');
  if (!/worker/i.test(text) || !/admin/i.test(text)) throw new Error('Canonical skill must document worker and admin role boundaries.');
  return `${CANONICAL_SKILL} metadata and worker workflow validated`;
}

function validateBinding(config, label) {
  const binding = config?.mcpServers?.vibesync;
  if (!binding || typeof binding.command !== 'string' || !Array.isArray(binding.args)) {
    throw new Error(`${label} must define mcpServers.vibesync with command and args.`);
  }
  const packagedBin = /^vibesync(?:-bun)?$/.test(binding.command);
  const scriptEntry = binding.args.some(arg => /vibesync(?:-bun)?\.mjs$/.test(String(arg)));
  if (!packagedBin && !scriptEntry) {
    throw new Error(`${label} does not launch the VibeSync MCP entrypoint.`);
  }
}

function checkMcpConfiguration(repoRoot) {
  const configs = ['.mcp.example.json', '.mcp.bun.example.json'];
  for (const relative of configs) validateBinding(readJson(path.join(repoRoot, relative)), relative);
  return `${configs.length} generated MCP binding examples target VibeSync entrypoints`;
}

function publicDocumentation(repoRoot) {
  const candidates = ['README.md', 'docs/USAGE.md', 'docs/PRODUCT_BASELINE.md', 'docs/AGENT_IDE_SETUP.md'];
  return candidates.filter(relative => existing(path.join(repoRoot, relative)))
    .map(relative => [relative, fs.readFileSync(path.join(repoRoot, relative), 'utf8')]);
}

function checkRuntimePolicyDocs(repoRoot, context) {
  const docs = publicDocumentation(repoRoot);
  const combined = docs.map(([, text]) => text).join('\n');
  assertIncludes(combined.toLowerCase(), ['node', 'bun', 'worker', 'admin', 'approval', 'sandbox'], 'Runtime/policy documentation');
  const missingTools = [...new Set([...combined.matchAll(/\bvibesync_[a-z][a-z0-9_]+\b/g)].map(match => match[0]))]
    .filter(name => !context.tools.has(name))
    .sort();
  if (missingTools.length) throw new Error(`Public documentation names missing MCP tools: ${missingTools.join(', ')}`);
  if (!docs.some(([relative]) => relative === 'docs/AGENT_IDE_SETUP.md')) {
    throw new Error('Supported agent-IDE integration matrix missing: docs/AGENT_IDE_SETUP.md');
  }
  const matrix = fs.readFileSync(path.join(repoRoot, 'docs/AGENT_IDE_SETUP.md'), 'utf8');
  if (!matrix.includes(CANONICAL_SKILL)) throw new Error(`Agent-IDE bindings must point to ${CANONICAL_SKILL}.`);
  return `${docs.length} public documents; runtime/policy terms and MCP references validated`;
}

const checks = Object.freeze([
  ['package', checkPackage],
  ['cli_help', checkCliHelp],
  ['mcp_catalogs', checkMcpCatalogs],
  ['canonical_skill', checkCanonicalSkill],
  ['mcp_configuration', checkMcpConfiguration],
  ['runtime_policy_docs', checkRuntimePolicyDocs]
]);

function gitRevision(repoRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

function boundedMessage(error) {
  return String(error?.message || error || 'Unknown failure').replace(/\s+/g, ' ').slice(0, 500);
}

export async function createBaselineReceipt({ repoRoot = scriptRoot } = {}) {
  repoRoot = path.resolve(repoRoot);
  const context = {};
  const evidence = [];
  for (const [id, run] of checks) {
    try {
      evidence.push({ id, status: 'pass', summary: boundedMessage(await run(repoRoot, context)) });
    } catch (error) {
      evidence.push({ id, status: 'fail', summary: boundedMessage(error) });
    }
  }
  const packageJson = context.packageJson || (() => {
    try { return readJson(path.join(repoRoot, 'package.json')); } catch { return {}; }
  })();
  return {
    format: RECEIPT_FORMAT,
    version: packageJson.version || null,
    git_revision: gitRevision(repoRoot),
    runtime: { name: typeof Bun === 'undefined' ? 'node' : 'bun', version: typeof Bun === 'undefined' ? process.versions.node : Bun.version },
    platform: { os: process.platform, arch: process.arch },
    checked_surfaces: CHECK_IDS,
    status: evidence.every(item => item.status === 'pass') ? 'pass' : 'fail',
    evidence
  };
}

export function parseBaselineArgs(argv) {
  const args = { repoRoot: scriptRoot, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--repo') args.repoRoot = path.resolve(argv[++index] || '');
    else if (value === '--output') args.output = path.resolve(argv[++index] || '');
    else if (value === '--help' || value === '-h') args.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseBaselineArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: vibesync-baseline [--repo PATH] [--output RECEIPT.json]\n');
    return 0;
  }
  const receipt = await createBaselineReceipt({ repoRoot: args.repoRoot });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(json) > 32 * 1024) throw new Error('Baseline receipt exceeded the 32 KiB limit.');
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, json);
  }
  process.stdout.write(json);
  return receipt.status === 'pass' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${boundedMessage(error)}${os.EOL}`);
    process.exitCode = 1;
  });
}
