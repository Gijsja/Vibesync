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
  if (!Array.isArray(value) || !value.length || value.some(arg => typeof arg !== 'string' || arg.includes('\0'))) invalid(`${name} must be a string or non-empty argv array.`);
  return value;
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
    setup: commands(body.setup, 'setup')
  };
}
