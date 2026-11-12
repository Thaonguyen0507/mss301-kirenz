import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { source: process.env.KIRENZ_SOURCE_DIR || 'D:/Kirenz-platform', check: false };
const projectName = 'kirenz-integration';
const composeFile = path.join(root, 'compose.integration.json');
const startedAt = new Date().toISOString();
const stages = [];
let sourcePath;
let docker;
let childEnvironment;

for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--help' || argument === '-h') {
    console.log('Usage: node scripts/run-local.mjs [--source D:/Kirenz-platform] [--check]\n\nPrerequisites: Node.js 20+, npm ci in this folder, and Docker Desktop/Linux engine running.\n--source  Kirenz source checkout; also configurable through KIRENZ_SOURCE_DIR.\n--check   Validate local configuration and print the execution plan without running Docker or tests.\n\nThe default run builds/validates collections, builds/starts the isolated Docker stack,\nruns four suites: Newman, WebSocket, Kafka event projection, and service resilience.\nLater suites still run when earlier assertions fail; final reports are summarized afterward.\nContainers and volumes remain available after the run; nothing is automatically stopped or removed.');
    process.exit(0);
  }
  if (argument === '--source') {
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--source requires a source directory.');
    options.source = args[++index];
  } else if (argument === '--check') {
    options.check = true;
  } else {
    throw new Error('Unknown option: ' + argument + '. Use --help.');
  }
}

async function exists(filename) {
  try { await fs.access(filename); return true; } catch { return false; }
}

async function readJson(filename) {
  return JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, ''));
}

function assertLoopbackUrl(value, label) {
  const parsed = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) throw new Error(label + ' must use HTTP or WebSocket.');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) throw new Error(label + ' must target loopback Docker local.');
  if (parsed.username || parsed.password || parsed.hash) throw new Error(label + ' must not contain URL credentials or a fragment.');
}

async function checkEnvironment() {
  const environment = await readJson(path.join(root, 'Kirenz-Local.postman_environment.json'));
  const values = new Map((environment.values ?? []).map(variable => [variable.key, variable.value]));
  if (!values.get('base_url')) throw new Error('The shipped local environment has no base_url.');
  for (const [key, value] of values) {
    if ((key === 'base_url' || key.endsWith('_base_url') || key === 'mailbox_url') && value) assertLoopbackUrl(value, key);
  }
  const collection = await readJson(path.join(root, 'Kirenz-Integration.postman_collection.json'));
  const visit = (items) => {
    for (const item of items ?? []) {
      if (item.item) { visit(item.item); continue; }
      const raw = typeof item.request?.url === 'string' ? item.request.url : item.request?.url?.raw;
      if (typeof raw !== 'string') throw new Error('Integration request is missing its URL.');
      const rendered = raw.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
        const value = values.get(key);
        return value === undefined || value === '' ? 'test-fixture' : String(value);
      });
      assertLoopbackUrl(rendered, 'Integration request ' + item.name);
    }
  };
  visit(collection.item);
}

async function preflight() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  sourcePath = await fs.realpath(path.resolve(options.source)).catch(() => { throw new Error('Kirenz source directory does not exist. Pass --source with the correct checkout path.'); });
  const requiredModules = ['identity-service', 'user-service', 'social-service', 'chat-service', 'notification-service', 'admin-service', 'api-gateway', 'discovery-service'];
  for (const name of requiredModules) {
    if (!await exists(path.join(sourcePath, name, 'pom.xml'))) throw new Error('Kirenz source module is missing: ' + name);
  }
  if (!await exists(path.join(sourcePath, 'spring-service.Dockerfile'))) throw new Error('Kirenz source Dockerfile is missing.');
  for (const dependency of ['newman', 'ws', 'postman-collection', 'ajv-draft-04']) {
    if (!await exists(path.join(root, 'node_modules', dependency, 'package.json'))) throw new Error('Dependencies are missing. Run npm ci in kirenz-postman before running this script.');
  }
  const compose = await readJson(composeFile);
  if (compose.name !== projectName) throw new Error('Compose project must remain kirenz-integration.');
  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (service.container_name) throw new Error('Fixed container names are not allowed in the isolated test stack: ' + name);
    for (const port of service.ports ?? []) {
      const loopback = typeof port === 'string'
        ? /^(?:127\.0\.0\.1:|\[::1\]:|localhost:)/.test(port)
        : ['127.0.0.1', '::1', 'localhost'].includes(port.host_ip);
      if (!loopback) throw new Error('Published test ports must bind only to loopback: ' + name);
    }
  }
  for (const [name, volume] of Object.entries(compose.volumes ?? {})) {
    if (volume?.external || volume?.name) throw new Error('Test volumes must be scoped to the Compose project: ' + name);
  }
  for (const [name, network] of Object.entries(compose.networks ?? {})) {
    if (network?.external || network?.name) throw new Error('Test networks must be scoped to the Compose project: ' + name);
  }
  docker = process.env.DOCKER_BIN || (process.platform === 'win32' && await exists('C:/Program Files/Docker/Docker/resources/bin/docker.exe')
    ? 'C:/Program Files/Docker/Docker/resources/bin/docker.exe'
    : 'docker');
  childEnvironment = { ...process.env, KIRENZ_SOURCE_DIR: sourcePath.replaceAll('\\', '/'), DOCKER_BIN: docker };
}

async function runStage(name, executable, commandArgs) {
  const start = Date.now();
  console.log('\n' + name);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(executable, commandArgs, { cwd: root, env: childEnvironment, stdio: 'inherit', shell: false, windowsHide: true });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code: typeof code === 'number' ? code : 1, signal: signal || undefined }));
    });
  } catch (error) {
    result = { code: 1, error: error.message };
  }
  stages.push({ name, exitCode: result.code, durationMs: Date.now() - start, ...(result.signal ? { signal: result.signal } : {}), ...(result.error ? { error: result.error } : {}) });
  return result.code;
}

async function requireStage(name, executable, commandArgs) {
  const code = await runStage(name, executable, commandArgs);
  if (code !== 0) throw new Error(name + ' failed (exit ' + code + '). See the preceding output.');
}

const composeArgs = ['compose', '-p', projectName, '-f', composeFile];
let exitCode = 0;
let failure;
try {
  await preflight();
  if (options.check) {
    await checkEnvironment();
    console.log(JSON.stringify({ status: 'configuration-valid', sourcePath, project: projectName, composeFile, steps: ['Build collections', 'Validate collections', 'Docker engine check', 'Docker compose up -d --build', 'Newman integration', 'WebSocket integration', 'Kafka event-projection integration', 'Service resilience integration', 'Summarize test reports'], automaticTeardown: false }, null, 2));
  } else {
    await requireStage('Build Postman collections', process.execPath, [path.join(root, 'scripts/build-collections.mjs')]);
    await requireStage('Validate Postman collections', process.execPath, [path.join(root, 'scripts/validate.mjs')]);
    await checkEnvironment();
    await requireStage('Check Docker engine', docker, ['info', '--format', '{{.ServerVersion}}']);
    await requireStage('Build and start isolated Docker stack', docker, [...composeArgs, 'up', '-d', '--build']);
    const restStartedAt = Date.now();
    const restCode = await runStage('Run Newman integration tests', process.execPath, [path.join(root, 'scripts/run-newman.mjs')]);
    const runtimeEnvironment = path.join(root, '.local/runtime.postman_environment.json');
    const runtimeStat = await fs.stat(runtimeEnvironment).catch(() => null);
    let websocketCode;
    let projectionCode;
    let resilienceCode;
    if (runtimeStat && runtimeStat.mtimeMs >= restStartedAt - 1000) {
      websocketCode = await runStage('Run WebSocket integration tests', process.execPath, [path.join(root, 'scripts/test-websocket.mjs'), '--environment', runtimeEnvironment]);
      projectionCode = await runStage('Run Kafka event-projection integration tests', process.execPath, [path.join(root, 'scripts/test-event-projection.mjs'), '--environment', runtimeEnvironment]);
      resilienceCode = await runStage('Run service resilience integration tests', process.execPath, [path.join(root, 'scripts/test-resilience.mjs'), '--environment', runtimeEnvironment]);
    } else {
      websocketCode = 1;
      projectionCode = 1;
      resilienceCode = 1;
      stages.push({ name: 'Run WebSocket integration tests', exitCode: 1, status: 'skipped', reason: 'Newman did not produce a fresh runtime environment; refusing stale fixture credentials.' });
      stages.push({ name: 'Run Kafka event-projection integration tests', exitCode: 1, status: 'skipped', reason: 'Newman did not produce a fresh runtime environment; refusing stale fixture credentials.' });
      stages.push({ name: 'Run service resilience integration tests', exitCode: 1, status: 'skipped', reason: 'Newman did not produce a fresh runtime environment; refusing stale fixture credentials.' });
      console.error('Dependent integration suites require a fresh runtime environment from the current Newman run.');
    }
    const summaryCode = await runStage('Summarize test reports', process.execPath, [path.join(root, 'scripts/summarize.mjs')]);
    exitCode = restCode || websocketCode || projectionCode || resilienceCode || summaryCode ? 1 : 0;
    console.log('\nDocker test containers and volumes remain available for inspection.');
    console.log('Reports: reports/summary.json, TEST-RESULTS.md, reports/newman-report.json, reports/newman-junit.xml, reports/websocket-report.json, reports/event-projection-report.json, reports/resilience-report.json');
  }
} catch (error) {
  exitCode = 1;
  failure = error.message;
  console.error(failure);
} finally {
  if (!options.check) {
    const summary = { startedAt, finishedAt: new Date().toISOString(), status: exitCode ? 'failed' : 'passed', sourcePath, project: projectName, composeFile, automaticTeardown: false, stages, ...(failure ? { error: failure } : {}) };
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports/local-run-report.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  }
}
process.exitCode = exitCode;
