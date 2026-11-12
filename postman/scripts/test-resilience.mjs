import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const environmentPath = path.resolve(option('--environment', path.join(root, '.local/runtime.postman_environment.json')));
const reportPath = path.resolve(option('--report', path.join(root, 'reports/resilience-report.json')));
const requestTimeoutMs = Math.max(1000, Math.min(10000, Number(option('--timeout-ms', '10000')) || 10000));
const recoveryTimeoutMs = Math.max(10000, Math.min(90000, Number(option('--recovery-ms', '90000')) || 90000));
const docker = process.env.DOCKER_BIN || (process.platform === 'win32' ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker');
const project = 'kirenz-integration';
const service = 'identity-service';
const compose = ['compose', '-p', project, '-f', path.join(root, 'compose.integration.json')];
const startedAt = new Date().toISOString();
const cases = [];
const actions = [];
let secrets = [];
let values;
let containerId;
let stopAttempted = false;
let restoreCompleted = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(0, 1200);
}

function loopbackUrl(value, label) {
  const url = new URL(value);
  assert.ok(['http:', 'https:'].includes(url.protocol), label + ' must use HTTP');
  assert.ok(['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname), label + ' must target isolated localhost; production execution is disabled');
  assert.equal(url.username, '', label + ' must not contain credentials');
  assert.equal(url.password, '', label + ' must not contain credentials');
  assert.equal(url.search, '', label + ' must not contain query parameters');
  assert.equal(url.hash, '', label + ' must not contain a fragment');
  return url.toString().replace(/\/$/, '');
}

async function command(commandArgs, timeout = 30000) {
  try {
    const result = await execFileAsync(docker, commandArgs, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true });
    return result.stdout.trim();
  } catch (error) {
    throw new Error('Docker command failed (' + commandArgs[0] + '): ' + redact(error.stderr || error.message));
  }
}

async function inspect(id) {
  const objects = JSON.parse(await command(['inspect', id]));
  assert.equal(objects.length, 1, 'Expected exactly one Docker container');
  const container = objects[0];
  assert.equal(container.Config?.Labels?.['com.docker.compose.project'], project, 'Refusing action outside isolated Compose project');
  return container;
}

async function runCase(name, callback) {
  const start = Date.now();
  try {
    const details = await callback();
    cases.push({ name, status: 'passed', durationMs: Date.now() - start, ...(details ? { details } : {}) });
    console.log('PASS ' + name);
    return true;
  } catch (error) {
    const message = redact(error?.message ?? error);
    cases.push({ name, status: 'failed', durationMs: Date.now() - start, error: message });
    console.log('FAIL ' + name + ': ' + message);
    return false;
  }
}

async function getJson(url, authenticated = true) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + values.admin_access_token } : {}) },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

async function summary() {
  return getJson(values.base_url + '/api/admin/dashboard/summary');
}

function assertHealthy(result) {
  assert.equal(result.status, 200, 'Dashboard HTTP status');
  assert.equal(result.body?.success, true, 'Dashboard success envelope');
  assert.equal(result.body?.data?.partialData, false, 'Dashboard must not have partial fallback');
  assert.deepEqual(result.body?.data?.unavailableComponents, [], 'All dashboard owners must be available');
  assert.ok(Number.isFinite(result.body?.data?.totalUsers), 'Identity counter must be numeric');
}

async function poll(callback, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const details = await callback();
      return { attempts, ...details };
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error('Timed out after ' + attempts + ' probes: ' + redact(lastError?.message || 'condition not reached'));
}

async function restoreIdentity() {
  const recoveryDeadline = Date.now() + recoveryTimeoutMs;
  await runCase('Restart the same isolated Identity container in finally', async () => {
    const before = await inspect(containerId);
    assert.equal(before.Config?.Labels?.['com.docker.compose.service'], service, 'Identity service label changed');
    actions.push({ at: new Date().toISOString(), action: 'start', project, service, container: containerId.slice(0, 12) });
    await command([...compose, 'start', service]);
    const after = await inspect(containerId);
    assert.equal(after.State?.Running, true, 'Identity container must be running after start');
    restoreCompleted = true;
    return { containerRunning: true };
  });
  if (!restoreCompleted) return;
  await runCase('Identity health recovers after restart', async () => {
    return poll(async () => {
      const health = await getJson(values.identity_base_url + '/actuator/health', false);
      assert.equal(health.status, 200, 'Identity health HTTP status');
      assert.equal(health.body?.status, 'UP', 'Identity actuator status');
      return { status: health.body.status };
    }, Math.max(1, recoveryDeadline - Date.now()));
  });
  await runCase('Dashboard returns complete data after Identity recovery', async () => {
    return poll(async () => {
      const response = await summary();
      assertHealthy(response);
      return { httpStatus: response.status, partialData: false };
    }, Math.max(1, recoveryDeadline - Date.now()));
  });
}

async function main() {
  const setup = await runCase('Validate isolated environment and exact Docker targets', async () => {
    const parsed = JSON.parse(await fs.readFile(environmentPath, 'utf8'));
    values = Array.isArray(parsed.values)
      ? Object.fromEntries(parsed.values.filter((entry) => entry.enabled !== false).map((entry) => [entry.key, entry.value]))
      : parsed;
    secrets = Object.entries(values).filter(([key, value]) => /token|password|secret|api.?key/i.test(key) && typeof value === 'string' && value.length >= 6).map(([, value]) => value).sort((a, b) => b.length - a.length);
    values.base_url = loopbackUrl(values.base_url, 'base_url');
    values.identity_base_url = loopbackUrl(values.identity_base_url, 'identity_base_url');
    assert.ok(typeof values.admin_access_token === 'string' && values.admin_access_token.length > 20 && !values.admin_access_token.includes('{{'), 'Run npm test first to create admin_access_token');
    const ids = (await command([...compose, 'ps', '-q', service])).split(/\s+/).filter(Boolean);
    assert.equal(ids.length, 1, 'Expected exactly one running isolated Identity container');
    containerId = ids[0];
    const identity = await inspect(containerId);
    assert.equal(identity.Config?.Labels?.['com.docker.compose.service'], service, 'Refusing to stop a service other than Identity');
    assert.equal(identity.State?.Running, true, 'Identity must be running before fault injection');
    const adminIds = (await command([...compose, 'ps', '-q', 'admin-service'])).split(/\s+/).filter(Boolean);
    assert.equal(adminIds.length, 1, 'Expected one isolated Admin container');
    const admin = await inspect(adminIds[0]);
    assert.equal(admin.Config?.Labels?.['com.docker.compose.service'], 'admin-service', 'Unexpected Admin service label');
    assert.ok(admin.Config?.Env?.includes('ADMIN_DASHBOARD_CACHE_TTL=PT0S'), 'Set isolated ADMIN_DASHBOARD_CACHE_TTL=PT0S and recreate admin-service before controlled failure test');
    return { project, stoppedService: service, cacheTtl: 'PT0S' };
  });
  if (!setup) return;

  const baseline = await runCase('Dashboard baseline has all owner services', async () => {
    const response = await summary();
    assertHealthy(response);
    return { httpStatus: response.status, partialData: false, totalUsers: response.body.data.totalUsers };
  });
  if (!baseline) return;

  try {
    const stopped = await runCase('Stop only isolated Identity to inject dependency failure', async () => {
      const identity = await inspect(containerId);
      assert.equal(identity.Config?.Labels?.['com.docker.compose.service'], service, 'Service guard failed before stop');
      stopAttempted = true;
      actions.push({ at: new Date().toISOString(), action: 'stop', project, service, container: containerId.slice(0, 12) });
      await command([...compose, 'stop', '--timeout', '10', service]);
      const stoppedContainer = await inspect(containerId);
      assert.equal(stoppedContainer.State?.Running, false, 'Identity container must be stopped to validate fault injection');
      return { containerRunning: false };
    });
    if (!stopped) return;

    await runCase('Admin exposes partial dashboard while Identity is unavailable', async () => {
      return poll(async () => {
        const response = await summary();
        assert.equal(response.status, 200, 'Degraded dashboard must remain HTTP200');
        assert.equal(response.body?.success, true, 'Degraded dashboard success envelope');
        const data = response.body?.data;
        assert.equal(data?.partialData, true, 'partialData must be true during controlled outage');
        assert.ok(Array.isArray(data?.unavailableComponents) && data.unavailableComponents.includes('identity'), 'unavailableComponents must identify Identity');
        assert.ok(!data.unavailableComponents.includes('social'), 'Unstopped Social service must remain available');
        assert.equal(data.totalUsers, 0, 'Unavailable Identity counter must use declared zero fallback');
        assert.ok(Number.isFinite(data.posts) && Number.isFinite(data.pendingReports), 'Social/local counters must remain numeric');
        return { httpStatus: response.status, partialData: true, unavailableComponents: data.unavailableComponents };
      }, 60000);
    });
  } finally {
    if (stopAttempted) await restoreIdentity();
  }
}

if (args.includes('--help')) {
  console.log('node scripts/test-resilience.mjs [--environment .local/runtime.postman_environment.json] [--report reports/resilience-report.json] [--timeout-ms 10000] [--recovery-ms 90000]');
  console.log('Stops and restarts ONLY identity-service in the kirenz-integration Docker project, checks Admin partial fallback and recovery. Requires npm test fixture and cache TTL PT0S. Refuses non-loopback targets.');
} else {
  try {
    await main();
  } catch (error) {
    cases.push({ name: 'Resilience runner setup', status: 'failed', durationMs: 0, error: redact(error?.message ?? error) });
    if (stopAttempted && !restoreCompleted) await restoreIdentity();
  } finally {
    const summary = {
      total: cases.length,
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      stoppedServiceRestored: !stopAttempted || restoreCompleted,
    };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      suite: 'Kirenz controlled cross-service dependency failure and recovery',
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceTree: '5e439abc2ded3f0efdefbce0941f6ce07dd0bbcf',
      scope: 'Only loopback kirenz-integration Docker Identity container; no production or external provider calls.',
      target: values?.base_url,
      environmentFile: path.basename(environmentPath),
      summary,
      actions,
      cases,
    }, null, 2) + '\n', 'utf8');
    console.log('Resilience integration: ' + summary.passed + ' passed, ' + summary.failed + ' failed. Report: ' + reportPath);
    if (summary.failed || !summary.stoppedServiceRestored) process.exitCode = 1;
  }
}
