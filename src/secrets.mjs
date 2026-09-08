const SECRET_PATTERNS = [
  { code: 'private_key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { code: 'github_token', pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { code: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ }
];

/** Scan supplied file contents without returning secret material. */
export function scanSecretEntries(entries) {
  const findings = [];
  for (const { file, content } of entries) {
    if (typeof content !== 'string' || content.includes('\0')) continue;
    for (const { code, pattern } of SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push({ file, code });
    }
  }
  return findings;
}
