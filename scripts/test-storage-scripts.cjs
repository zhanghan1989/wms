const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-disk-test-'));
try {
  const binaries = path.join(temporary, 'bin');
  fs.mkdirSync(binaries);
  const executable = (name, source) => fs.writeFileSync(path.join(binaries, name), '#!/bin/bash\n' + source, { mode: 0o700 });
  executable('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\nmock 41943040 20000000 %s %s%% /\\n" "$TEST_FREE_KIB" "$TEST_USED_PERCENT"\n');
  executable('date', 'echo 2000000000\n');
  executable('flock', 'exit 0\n');
  executable('logger', 'echo "$*" >> "$TEST_LOG"\n');
  const env = { ...process.env, PATH: binaries + path.delimiter + process.env.PATH,
    TEST_FREE_KIB: '8388608', TEST_USED_PERCENT: '50', TEST_LOG: path.join(temporary, 'events'),
    WMS_DEPLOY_MIN_DISK_BYTES: '2147483648', WMS_STORAGE_STATE_DIR: path.join(temporary, 'state'),
    WMS_MYSQL_DATA_PATH: path.join(temporary, 'no-mysql'), WMS_STORAGE_WARN_PERCENT: '75',
    WMS_STORAGE_CRITICAL_PERCENT: '90', WMS_STORAGE_MIN_FREE_BYTES: '5368709120' };
  const run = (script, args = [], overrides = {}) => spawnSync('bash', [path.join(root, 'scripts', script), ...args],
    { env: { ...env, ...overrides }, encoding: 'utf8' });
  assert.equal(run('wms-disk-check.sh', ['/', '3221225472']).status, 0);
  assert.equal(run('wms-disk-check.sh', ['/', '3221225472'], { TEST_FREE_KIB: '4194304' }).status, 1,
    'reject before a transfer consumes the reserve');
  assert.equal(run('wms-disk-check.sh', ['/', '0'], { WMS_DEPLOY_MIN_DISK_BYTES: '-1' }).status, 1);
  assert.equal(run('wms-disk-check.sh', ['/', '0'], { TEST_FREE_KIB: 'unknown' }).status, 1);
  assert.equal(run('wms-storage-health.sh').status, 0);
  const high = run('wms-storage-health.sh', [], { TEST_FREE_KIB: '4500000', TEST_USED_PERCENT: '89' });
  assert.equal(high.status, 1);
  assert.match(high.stdout, /severity=HIGH/);
  const eventCount = fs.readFileSync(env.TEST_LOG, 'utf8').trim().split('\n').length;
  run('wms-storage-health.sh', [], { TEST_FREE_KIB: '4500000', TEST_USED_PERCENT: '89' });
  assert.equal(fs.readFileSync(env.TEST_LOG, 'utf8').trim().split('\n').length, eventCount, 'do not repeat unchanged alerts');
  assert.equal(run('wms-storage-health.sh').status, 0);
  // Simulate a daily consumption rate that exhausts otherwise-low usage in <7 days.
  fs.writeFileSync(path.join(env.WMS_STORAGE_STATE_DIR, 'baseline'), '1999913600 10737418240\n');
  const growth = run('wms-storage-health.sh', [], { TEST_FREE_KIB: '6291456' });
  assert.equal(growth.status, 1);
  assert.match(growth.stdout, /estimated_days=1/);
  console.log('PASS: disk reserve, malformed readings, alert transitions, and growth forecasting');
} finally { fs.rmSync(temporary, { recursive: true }); }
