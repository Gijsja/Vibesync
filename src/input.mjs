/** Public API input validation. Database helpers remain usable for repair/import. */
function invalid(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
function string(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) invalid(`${name} must be a non-empty string (maximum ${max} characters).`);
  return value.trim();
}
export function identifier(value, name = 'id') {
  const id = string(value, name, 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) invalid(`${name} may contain only letters, numbers, periods, underscores and hyphens.`);
  return id;
}
function inputCommand(value, name) {
  if (typeof value === 'string') return string(value, name, 4000);
  if (Array.isArray(value)) {
    if (!value.length || value.some(arg => typeof arg !== 'string' || arg.includes('\0'))) invalid(`${name} must be a string, structured command, or non-empty argv array.`);
    return value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be a string, structured command, or non-empty argv array.`);
  const type = value.type || 'argv';
  if (!['argv', 'node-test', 'npm-script', 'pytest', 'make'].includes(type)) invalid(`${name}.type is not supported.`);
  const result = { type };
  if (value.argv !== undefined) result.argv = inputCommand(value.argv, `${name}.argv`);
  if (value.command !== undefined) result.command = inputCommand(value.command, `${name}.command`);
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) invalid(`${name}.args must be an array of NUL-free strings.`);
    result.args = value.args;
  }
  if (value.script !== undefined) result.script = string(value.script, `${name}.script`, 100);
  if (value.target !== undefined) result.target = string(value.target, `${name}.target`, 100);
  if (value.timeout_ms !== undefined) {
    if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 3600000) invalid(`${name}.timeout_ms must be between 1 and 3600000.`);
    result.timeout_ms = value.timeout_ms;
  }
  if (value.network !== undefined) result.network = Boolean(value.network);
  if (value.write_paths !== undefined) {
    if (!Array.isArray(value.write_paths) || value.write_paths.some(item => typeof item !== 'string' || item.includes('\0'))) invalid(`${name}.write_paths must be an array of NUL-free strings.`);
    result.write_paths = value.write_paths;
  }
  if (value.idempotency !== undefined) result.idempotency = string(value.idempotency, `${name}.idempotency`, 20);
  return result;
}
export function featureInput(body) {
  return {
    id: body.id === undefined ? undefined : identifier(body.id), title: string(body.title, 'title', 300),
    target_milestone: string(body.target_milestone || 'v1.0', 'target_milestone', 80),
    spec_markdown: string(body.spec_markdown, 'Acceptance criteria', 50000),
    holistic_gate_cmd: inputCommand(body.holistic_gate_cmd || ['git', 'diff', '--check'], 'holistic_gate_cmd')
  };
}
export function taskInput(body) {
  const list = (value, name, fallback) => {
    const entries = value === undefined ? fallback : value;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) invalid(`${name} must contain between 1 and 100 entries.`);
    return entries.map(entry => string(entry, name, 4000));
  };
  const commands = (value, name) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) invalid(`${name} must be an array with at most 20 commands.`);
    return value.map(value => inputCommand(value, name));
  };
  return {
    id: body.id === undefined ? undefined : identifier(body.id), feature_id: identifier(body.feature_id, 'feature_id'),
    title: string(body.title, 'title', 300),
    allowed_paths: list(body.allowed_paths, 'allowed_paths', ['src/**']),
    required_gates: body.required_gates === undefined ? [['git', 'diff', '--check']] : commands(body.required_gates, 'required_gates'),
    setup: commands(body.setup, 'setup'),
    model_hint: body.model_hint === undefined ? null : (() => {
      const hint = string(body.model_hint, 'model_hint', 40);
      if (!['gemini', 'claude', 'codex', 'local', 'generic'].includes(hint)) invalid('model_hint must be gemini, claude, codex, local, or generic.');
      return hint;
    })()
  };
}
