import { spawnSync } from 'node:child_process';

/** Parse a legacy command string without invoking a shell. New contracts should use argv arrays. */
export function normalizeCommand(command) {
  if (Array.isArray(command)) {
    if (!command.length || command.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
      throw new Error('Command arrays must contain one or more NUL-free strings.');
    }
    return [...command];
  }
  if (typeof command !== 'string' || !command.trim()) throw new Error('Command must be a non-empty argv array or string.');
  const argv = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if ('|;&<>`'.includes(char)) {
      throw new Error('Unquoted shell operators are not allowed. Express the command as an argv array; use an explicit shell executable only when a shell is intentionally required.');
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) {
      if (token) { argv.push(token); token = ''; }
    } else token += char;
  }
  if (escaped || quote) throw new Error('Command contains an unterminated quote or escape.');
  if (token) argv.push(token);
  if (!argv.length) throw new Error('Command is empty.');
  return argv;
}

export function displayCommand(command) {
  return Array.isArray(command) ? command.map(arg => JSON.stringify(arg)).join(' ') : command;
}

/** Keep the first useful failure lines, while full output can still be persisted as an artifact. */
export function summarizeFailure(stdout = '', stderr = '', maxLines = 12, maxChars = 2400) {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const useful = lines.filter(line => /(?:fail|error|assert|expected|actual|exception|not ok|✗|×)/i.test(line));
  const selected = (useful.length ? useful : lines).slice(0, maxLines).join('\n');
  return selected.slice(0, maxChars);
}

export function runCommand(command, options = {}) {
  let argv;
  try { argv = normalizeCommand(command); }
  catch (error) {
    return { success: false, cmd: displayCommand(command || ''), argv: [], exitCode: 1, stdout: '', stderr: error.message, summary: error.message, error: error.message };
  }
  const timeout = options.timeoutMs ?? options.timeout ?? 300000;
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd || process.cwd(), encoding: 'utf8', timeout,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) }, shell: false
  });
  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  const exitCode = proc.status !== null ? proc.status : 1;
  let error = proc.error?.message;
  if (proc.error?.code === 'ETIMEDOUT') error = `Command timed out after ${timeout}ms`;
  else if (exitCode !== 0 && !error) error = `Command exited with non-zero code ${exitCode}`;
  return {
    success: proc.status === 0 && !proc.error,
    cmd: displayCommand(command), argv, exitCode, stdout, stderr,
    summary: summarizeFailure(stdout, stderr), error
  };
}
