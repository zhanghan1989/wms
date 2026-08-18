import { spawnSync } from 'node:child_process';

const audit = spawnSync('npm', ['audit', '--omit=dev', '--json'], {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});

if (audit.error) {
  console.error(`Unable to run npm audit: ${audit.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch (error) {
  console.error('npm audit did not return valid JSON.');
  if (audit.stderr) console.error(audit.stderr.trim());
  process.exit(1);
}

if (report.error || !report.auditReportVersion || !report.metadata?.vulnerabilities) {
  console.error(`npm audit failed: ${report.error?.summary ?? 'incomplete audit report'}`);
  process.exit(1);
}

const approvedExceptions = new Map([
  [
    'deepmerge-ts',
    {
      severity: 'high',
      advisorySources: new Set([1145093]),
      viaPackages: new Set(),
      allowFixAvailable: true,
      expiresAt: new Date('2026-09-18T00:00:00Z'),
      reason:
        'Prisma 6.19.3 pins deepmerge-ts 7.1.5 as a dev-only CLI dependency; awaiting a Prisma release that adopts the patched dependency.',
    },
  ],
  [
    '@prisma/config',
    {
      severity: 'high',
      advisorySources: new Set(),
      viaPackages: new Set(['deepmerge-ts']),
      allowFixAvailable: true,
      expiresAt: new Date('2026-09-18T00:00:00Z'),
      reason:
        'Transitive propagation of GHSA-ggr8-5vv4-36mx through the dev-only Prisma CLI; awaiting an upstream Prisma fix.',
    },
  ],
  [
    'prisma',
    {
      severity: 'high',
      advisorySources: new Set(),
      viaPackages: new Set(['@prisma/config']),
      allowFixAvailable: true,
      expiresAt: new Date('2026-09-18T00:00:00Z'),
      reason:
        'Transitive propagation of GHSA-ggr8-5vv4-36mx through the dev-only Prisma CLI; awaiting an upstream Prisma fix.',
    },
  ],
  [
    'xlsx',
    {
      severity: 'high',
      advisorySources: new Set([1108110, 1108111]),
      viaPackages: new Set(),
      allowFixAvailable: false,
      expiresAt: new Date('2026-09-04T00:00:00Z'),
      reason: 'No patched npm release is available; replacement work is tracked for the Amazon SP-API launch.',
    },
  ],
]);

const vulnerabilities = report.vulnerabilities ?? {};
const blockers = [];
const accepted = [];
const now = new Date();

for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
  if (!['high', 'critical'].includes(vulnerability.severity)) continue;

  const exception = approvedExceptions.get(packageName);
  const advisorySources = (vulnerability.via ?? [])
    .filter((item) => typeof item === 'object' && item !== null)
    .map((item) => item.source);
  const viaPackages = (vulnerability.via ?? []).filter((item) => typeof item === 'string');
  const advisoriesMatch =
    advisorySources.length === exception?.advisorySources.size &&
    advisorySources.every((source) => exception.advisorySources.has(source));
  const viaPackagesMatch =
    viaPackages.length === exception?.viaPackages.size &&
    viaPackages.every((packageName) => exception.viaPackages.has(packageName));
  const fixAvailabilityAccepted =
    vulnerability.fixAvailable === false || exception?.allowFixAvailable === true;
  const exceptionIsValid =
    exception &&
    vulnerability.severity === exception.severity &&
    fixAvailabilityAccepted &&
    advisoriesMatch &&
    viaPackagesMatch &&
    now < exception.expiresAt;

  if (exceptionIsValid) {
    accepted.push({ packageName, vulnerability, exception });
    continue;
  }

  blockers.push({ packageName, vulnerability });
}

for (const { packageName, vulnerability } of blockers) {
  console.error(
    `Blocking ${vulnerability.severity} production dependency vulnerability: ${packageName}`,
  );
}

if (blockers.length > 0) {
  console.error('Resolve the vulnerabilities or document a time-limited exception before release.');
  process.exit(1);
}

for (const { packageName, exception } of accepted) {
  console.warn(
    `Temporary exception: ${packageName} (${exception.severity}) until ${exception.expiresAt
      .toISOString()
      .slice(0, 10)}. ${exception.reason}`,
  );
}

const totals = report.metadata?.vulnerabilities ?? {};
console.log(
  `Production dependency audit passed (critical=${totals.critical ?? 0}, high=${
    totals.high ?? 0
  }, accepted=${accepted.length}).`,
);
