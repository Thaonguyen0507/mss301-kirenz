import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execute = promisify(execFile);
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const envFile = path.resolve(option('--environment', path.join(projectDir, '.local/runtime.postman_environment.json')));
const reportFile = path.resolve(option('--report', path.join(projectDir, 'reports/event-projection-report.json')));
const docker = process.env.DOCKER_BIN || (process.platform === 'win32' ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe' : 'docker');
const compose = ['compose', '-p', 'kirenz-integration', '-f', path.join(projectDir, 'compose.integration.json')];
const pollMs = Math.max(1000, Math.min(10000, Number(option('--poll-ms', '10000')) || 10000));
const startedAt = new Date().toISOString();
const cases = [];
const observations = [];
let fixtureId;
let secrets = [];

function redact(value) {
  let text = String(value ?? '');
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]').slice(0, 1200);
}

async function command(commandArgs, timeout = 4000) {
  try {
    const result = await execute(docker, commandArgs, { cwd: projectDir, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    const reason = error.killed ? 'timeout' : `exit ${error.code ?? 'unknown'}`;
    throw new Error(`Docker command failed (${reason}); inspect the isolated Compose project separately`);
  }
}

async function check(name, action) {
  const start = Date.now();
  try {
    const details = await action();
    cases.push({ name, status: 'passed', durationMs: Date.now() - start, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    cases.push({ name, status: 'failed', durationMs: Date.now() - start, error: redact(error.message ?? error) });
    console.log(`FAIL ${name}: ${redact(error.message ?? error)}`);
    return false;
  }
}

async function query(sql, timeout = 3000) {
  assert.match(sql, /^SELECT\s/i, 'Projection checker only accepts read-only SELECT statements');
  return command([
    ...compose, 'exec', '-T', '-e', 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=1500',
    'postgres', 'psql', '-X', '-q', '-A', '-t', '-U', 'kirenz_it', '-d', 'kirenz_user',
    '-v', 'ON_ERROR_STOP=1', '-c', sql,
  ], timeout);
}

async function main() {
  const runtimeReady = await check('Runtime administrator fixture is available', async () => {
    let runtime;
    try { runtime = JSON.parse(await readFile(envFile, 'utf8')); } catch { throw new Error('Could not load runtime Postman environment JSON; run the integration fixture/login setup first'); }
    const values = Array.isArray(runtime.values)
      ? Object.fromEntries(runtime.values.filter((entry) => entry.enabled !== false).map((entry) => [entry.key, entry.value]))
      : runtime;
    secrets = Object.entries(values).filter(([key, value]) => /token|password|secret|api.?key/i.test(key) && typeof value === 'string' && value.length >= 6).map(([, value]) => value).sort((a, b) => b.length - a.length);
    fixtureId = values.admin_user_id;
    assert.match(fixtureId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'admin_user_id must contain the UUID created by the isolated fixture setup');
    if (values.admin_email) assert.match(values.admin_email, /^kirenz_it_.*_admin@example\.invalid$/, 'Administrator must be the isolated kirenz_it fixture');
    if (values.base_url) {
      const url = new URL(values.base_url);
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Runtime environment must target Docker localhost');
    }
    return { fixture: 'administrator created through Identity registration; no User privacy API called' };
  });
  if (!runtimeReady) return;

  const guarded = await check('PostgreSQL belongs to kirenz-integration Compose project', async () => {
    const id = await command([...compose, 'ps', '-q', 'postgres']);
    assert.match(id, /^[0-9a-f]{12,64}$/i, 'Expected exactly one isolated PostgreSQL container');
    const project = await command(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', id]);
    const service = await command(['inspect', '--format', '{{index .Config.Labels "com.docker.compose.service"}}', id]);
    const running = await command(['inspect', '--format', '{{.State.Running}}', id]);
    assert.equal(project, 'kirenz-integration', 'Refusing database access outside isolated integration project');
    assert.equal(service, 'postgres', 'Refusing database access outside isolated postgres service');
    assert.equal(running, 'true', 'Isolated PostgreSQL must be running');
    return { project, service, database: 'kirenz_user', access: 'SELECT only; default_transaction_read_only=on' };
  });
  if (!guarded) return;

  const schemaReady = await check('User owner schema exposes privacy_settings.user_id UUID', async () => {
    const sql = "SELECT to_regclass('public.privacy_settings') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='privacy_settings' AND column_name='user_id' AND udt_name='uuid');";
    assert.equal(await query(sql), 't', 'Owner migration 003-add-privacy-settings-schema.sql is not applied');
  });
  if (!schemaReady) return;

  await check('Identity user-created Kafka event creates exactly one User privacy projection', async () => {
    const began = Date.now();
    const deadline = began + pollMs;
    const sql = `SELECT json_build_object('rowCount',count(*),'defaultsValid',coalesce(bool_and(profile_visibility='PUBLIC' AND post_visibility='PUBLIC' AND allow_direct_messages=true AND show_online_status=true),false))::text FROM public.privacy_settings WHERE user_id='${fixtureId}'::uuid;`;
    let last;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining < 750 && last) break;
      const result = await query(sql, Math.max(100, Math.min(2500, remaining)));
      try { last = JSON.parse(result); } catch { throw new Error('Owner database projection query did not return expected JSON'); }
      observations.push({ elapsedMs: Date.now() - began, rowCount: last.rowCount, defaultsValid: last.defaultsValid });
      if (last.rowCount === 1) break;
      if (last.rowCount > 1) break;
      const delay = Math.min(400, deadline - Date.now());
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    assert.equal(last?.rowCount, 1, `IDENTITY-USER-CREATED-PROJECTION: expected one privacy_settings row from Kafka for untouched administrator fixture; observed ${last?.rowCount ?? 'none'} within ${pollMs} ms`);
    assert.equal(last.defaultsValid, true, 'Kafka-created projection must have default PUBLIC visibility and enabled DM/online flags');
    return { expectedRows: 1, observedRows: last.rowCount, defaultsValid: true, attempts: observations.length, pollLimitMs: pollMs };
  });
}

try {
  if (args.includes('--help')) {
    console.log('node scripts/test-event-projection.mjs [--environment .local/runtime.postman_environment.json] [--report reports/event-projection-report.json] [--poll-ms 10000]');
    console.log('Read-only owner-DB assertion of Identity -> user-created Kafka -> User privacy projection for the untouched administrator fixture. Never calls a privacy API or creates missing projection rows.');
  } else await main();
} catch (error) {
  cases.push({ name: 'Event projection checker setup', status: 'failed', durationMs: 0, error: redact(error.message ?? error) });
  console.error(`FAIL Event projection checker setup: ${redact(error.message ?? error)}`);
} finally {
  if (!args.includes('--help')) {
    const summary = { total: cases.length, passed: cases.filter((item) => item.status === 'passed').length, failed: cases.filter((item) => item.status === 'failed').length, skipped: 0 };
    const report = {
      suite: 'Identity -> Kafka -> User owner-DB projection',
      startedAt,
      finishedAt: new Date().toISOString(),
      environmentFile: path.basename(envFile),
      project: 'kirenz-integration',
      database: 'kirenz_user',
      table: 'public.privacy_settings',
      fixtureId,
      topic: 'user-created',
      consumerGroup: 'user-service-group',
      readOnly: true,
      source: {
        producer: 'identity-service/src/main/java/com/kirenz/identity_service/auth/service/AuthService.java',
        consumer: 'user-service/src/main/java/com/kirenz/user_service/identity/listener/UserEventListener.java',
        migration: 'user-service/src/main/resources/db/changelog/003-add-privacy-settings-schema.sql',
      },
      proofBoundary: 'Fixture is created by Identity registration. Harness must not call a User privacy endpoint for this administrator before this check, because those endpoints can lazily create rows and mask Kafka failures.',
      summary,
      observations,
      cases,
    };
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`Event projection: ${summary.passed} passed, ${summary.failed} failed. Report: ${reportFile}`);
    if (summary.failed) process.exitCode = 1;
  }
}
