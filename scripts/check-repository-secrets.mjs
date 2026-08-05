import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
if (listed.status !== 0) {
  console.error('Unable to list tracked files for secret scanning.');
  process.exit(1);
}

const highConfidencePatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

const protectedNames = [
  'DATABASE_URL',
  'MYSQL_ROOT_PASSWORD',
  'JWT_SECRET',
  'AUTH_MFA_ENCRYPTION_KEY',
  'THIRD_PARTY_API_KEY',
  'PRINT_AGENT_API_KEY',
  'XIYA_EXPORT_API_KEY',
  'XIYA_LOGISTICS_API_KEY',
  'UOF_TRACKING_APP_TOKEN',
  'UOF_TRACKING_APP_KEY',
  'AMAZON_SP_API_LWA_CLIENT_SECRET',
  'AMAZON_SP_API_ENCRYPTION_KEY',
];
const assignmentPattern = new RegExp(
  `\\b(${protectedNames.join('|')})[ \\t]*(?:=|:)[ \\t]*["']?([^"'\\s,]+)`,
  'g',
);
const safeValue = /(?:\$\{|process\.env|CHANGE[_-]?ME|EXAMPLE|PLACEHOLDER|REPLACE(?:[_-]?ME|[-_]?WITH)|YOUR-|<|\*{3}|\[REDACTED\])/i;
const findings = [];

for (const file of listed.stdout.split('\0').filter(Boolean)) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.includes(0)) continue;
  const content = buffer.toString('utf8');

  for (const [label, pattern] of highConfidencePatterns) {
    if (pattern.test(content)) findings.push(`${file}: ${label}`);
  }

  for (const match of content.matchAll(assignmentPattern)) {
    const value = match[2];
    const documentedExample = file.endsWith('.example');
    const testFixture = /(?:^|\/)test\//.test(file) || /\.spec\.[cm]?[jt]s$/.test(file);
    if (value && !safeValue.test(value) && !documentedExample && !testFixture) {
      findings.push(`${file}: literal ${match[1]}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Potential committed secrets detected:');
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Tracked repository secret scan passed.');
