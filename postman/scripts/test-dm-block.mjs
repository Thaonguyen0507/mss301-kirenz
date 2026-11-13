import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
};
const reportPath = path.resolve(option('--report', path.join(root, 'reports/dm-block-report.json')));
const timeoutMs = 8000;
const startedAt = new Date().toISOString();
const runId = Date.now().toString(36) + randomBytes(3).toString('hex');
const cases = [];
const requests = [];
const actors = {};
const secrets = [];
const createdCallIds = new Set();
const blocks = new Set();
let base;
let conversationId;
let privacyChanged = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(value) {
  let output = String(value ?? '');
  for (const secret of secrets) output = output.split(secret).join('[redacted]');
  return output
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(0, 1500);
}

async function check(name, callback) {
  const started = Date.now();
  try {
    const details = await callback();
    cases.push({ name, status: 'passed', durationMs: Date.now() - started, ...(details ? { details } : {}) });
    console.log('PASS ' + name);
    return true;
  } catch (error) {
    const message = redact(error?.message ?? error);
    cases.push({ name, status: 'failed', durationMs: Date.now() - started, error: message });
    console.log('FAIL ' + name + ': ' + message);
    return false;
  }
}

async function http(actor, route, method = 'GET', payload) {
  const started = Date.now();
  const response = await fetch(base + route, {
    method,
    headers: {
      Accept: 'application/json',
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(actor?.token ? { Authorization: 'Bearer ' + actor.token } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  requests.push({ actor: actor?.label ?? 'anonymous', method, path: route, status: response.status, durationMs: Date.now() - started });
  if (method === 'POST' && route === '/api/calls' && response.status === 200 && body?.data?.id) createdCallIds.add(body.data.id);
  return { status: response.status, body };
}

function success(response, status = 200) {
  assert.equal(response.status, status, 'Unexpected HTTP status');
  assert.equal(response.body?.success, true, 'Expected success ApiResponse');
  return response.body.data;
}

async function createActor(label) {
  const actor = {
    label,
    email: `kirenz_dm_${runId}_${label}@example.invalid`,
    username: `kirenz_dm_${runId}_${label}`,
    password: 'KirenzDM!' + randomBytes(12).toString('hex'),
  };
  secrets.push(actor.password, actor.email);
  const registered = success(await http(null, '/api/auth/register', 'POST', {
    email: actor.email,
    username: actor.username,
    password: actor.password,
    displayName: 'DM block fixture ' + runId + ' ' + label,
  }), 201);
  assert.match(registered?.id ?? '', /^[a-f0-9-]{36}$/i, 'Registration must return a user UUID');
  actor.id = registered.id;
  const login = success(await http(null, '/api/auth/login', 'POST', { email: actor.email, password: actor.password }));
  assert.ok(login?.accessToken, 'Login must return an access token');
  actor.token = login.accessToken;
  secrets.push(actor.token);
  actors[label] = actor;
  return actor;
}

async function permissions(expected) {
  for (const [sender, receiver] of [[actors.a, actors.b], [actors.b, actors.a]]) {
    const data = success(await http(sender, '/api/privacy/can-message/' + receiver.id));
    assert.equal(data, expected, sender.label + ' to ' + receiver.label + ' DM permission');
  }
}

async function block(sender, receiver) {
  success(await http(sender, '/api/blocks/' + receiver.id, 'POST'), 201);
  blocks.add(sender.label + ':' + receiver.label);
}

async function unblock(sender, receiver) {
  success(await http(sender, '/api/blocks/' + receiver.id, 'DELETE'));
  blocks.delete(sender.label + ':' + receiver.label);
}

async function rejectDirectConversation(sender, receiver) {
  const result = await http(sender, '/api/conversations/direct/' + receiver.id, 'POST');
  assert.equal(result.status, 403, sender.label + ' direct conversation must be denied');
  assert.equal(result.body?.success, false, 'Denied conversation must have an error envelope');
}

async function rejectCall(sender) {
  const result = await http(sender, '/api/calls', 'POST', { conversationId });
  assert.equal(result.status, 403, sender.label + ' call start must be denied');
  assert.equal(result.body?.success, false, 'Denied call must have an error envelope');
}

async function main() {
  const guarded = await check('Target is isolated loopback Gateway', async () => {
    const url = new URL(option('--base-url', 'http://localhost:18080'));
    assert.equal(url.protocol, 'http:', 'Use the HTTP test Gateway');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Production execution is disabled');
    assert.equal(url.port, '18080', 'Use the isolated test Gateway port 18080');
    assert.equal(url.pathname, '/', 'Base URL must not contain a path');
    assert.equal(url.username + url.password + url.search + url.hash, '', 'Base URL must not contain credentials, query or fragment');
    base = url.origin;
    return { baseUrl: base, fixtures: 'unique example.invalid accounts only' };
  });
  if (!guarded) return;

  const ready = await check('Gateway is ready for disposable fixture registration', async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try { if ((await http(null, '/api/posts/public')).status === 200) return; } catch {}
      await delay(750);
    }
    throw new Error('Gateway did not become ready within 90 seconds');
  });
  if (!ready) return;

  const registered = await check('Register and authenticate fresh A/B actors through Identity', async () => {
    await createActor('a');
    await createActor('b');
    assert.notEqual(actors.a.id, actors.b.id, 'Fixture actors must be distinct');
    return { actorsCreated: 2 };
  });
  if (!registered) return;

  const linked = await check('Direct conversation resolves through User and Identity Feign dependencies', async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const search = await http(actors.a, '/api/users/search?q=kirenz_dm_' + runId);
        const response = await http(actors.a, '/api/conversations/direct/' + actors.b.id, 'POST');
        if (search.status === 200 && response.status === 200) {
          const conversation = success(response);
          assert.equal(conversation.type, 'DIRECT');
          assert.ok(conversation.participants?.some((peer) => peer.userId === actors.a.id));
          assert.ok(conversation.participants?.some((peer) => peer.userId === actors.b.id));
          conversationId = conversation.id;
          return { conversationId, participants: 2 };
        }
      } catch {}
      await delay(1000);
    }
    throw new Error('Service-local Eureka/Feign dependencies did not become ready within 90 seconds');
  });
  if (!linked) return;

  await check('Unblocked permissive users can DM in both directions', () => permissions(true));
  const forwardBlock = await check('A blocking B denies DM permission in both directions', async () => {
    await block(actors.a, actors.b);
    await permissions(false);
  });
  if (forwardBlock || blocks.has('a:b')) {
    await check('Chat refuses direct conversations in both directions after a block', async () => {
      await rejectDirectConversation(actors.a, actors.b);
      await rejectDirectConversation(actors.b, actors.a);
    });
    await check('Chat refuses video-call start in both directions after a block', async () => {
      await rejectCall(actors.a);
      await rejectCall(actors.b);
    });
  }
  await check('Removing the block restores permissive DM policy', async () => {
    await unblock(actors.a, actors.b);
    await permissions(true);
  });

  let invitationId;
  const invitation = await check('A can create a video invitation before a later block', async () => {
    const call = success(await http(actors.a, '/api/calls', 'POST', { conversationId }));
    assert.equal(call.status, 'RINGING');
    invitationId = call.id;
  });
  if (invitation) {
    await check('B blocking A prevents acceptance of the existing invitation', async () => {
      await block(actors.b, actors.a);
      await permissions(false);
      const response = await http(actors.b, '/api/calls/' + invitationId + '/accept', 'POST');
      assert.equal(response.status, 403, 'Callee acceptance must recheck the latest DM policy');
      assert.equal(response.body?.success, false);
      const persisted = success(await http(actors.a, '/api/calls/' + invitationId));
      assert.equal(persisted.status, 'RINGING', 'Denied acceptance must not persist ACCEPTED');
    });
    await check('A can still end its invitation while the pair is blocked', async () => {
      const call = success(await http(actors.a, '/api/calls/' + invitationId + '/end', 'POST'));
      assert.equal(call.status, 'ENDED');
    });
  }

  await check('Unblocking one direction leaves the reciprocal block effective', async () => {
    if (!blocks.has('b:a')) await block(actors.b, actors.a);
    await block(actors.a, actors.b);
    await unblock(actors.a, actors.b);
    await permissions(false);
    await rejectCall(actors.a);
  });
  await check('Removing the last reciprocal block restores both DM directions', async () => {
    await unblock(actors.b, actors.a);
    await permissions(true);
  });

  await check('Restricted privacy still denies a nonfriend after all blocks are removed', async () => {
    success(await http(actors.b, '/api/privacy/me', 'PUT', { allowDirectMessages: false }));
    privacyChanged = true;
    assert.equal(success(await http(actors.a, '/api/privacy/can-message/' + actors.b.id)), false);
    assert.equal(success(await http(actors.b, '/api/privacy/can-message/' + actors.a.id)), true);
    await rejectCall(actors.a);
  });
  await check('Restoring privacy permits a fresh accepted call and clean hangup', async () => {
    success(await http(actors.b, '/api/privacy/me', 'PUT', { allowDirectMessages: true }));
    privacyChanged = false;
    await permissions(true);
    const started = success(await http(actors.a, '/api/calls', 'POST', { conversationId }));
    assert.equal(started.status, 'RINGING');
    const accepted = success(await http(actors.b, '/api/calls/' + started.id + '/accept', 'POST'));
    assert.equal(accepted.status, 'ACCEPTED');
    const ended = success(await http(actors.a, '/api/calls/' + started.id + '/end', 'POST'));
    assert.equal(ended.status, 'ENDED');
    assert.equal(ended.mediaClosed, true, 'No provider room was requested by this regression');
  });
}

async function cleanup() {
  if (!actors.a?.token || !actors.b?.token) return;
  await check('Cleanup ends fixture calls and removes fixture-only blocks', async () => {
    const errors = [];
    for (const id of createdCallIds) {
      try { success(await http(actors.a, '/api/calls/' + id + '/end', 'POST')); }
      catch (error) { errors.push('call cleanup: ' + redact(error.message)); }
    }
    for (const key of [...blocks]) {
      const [from, to] = key.split(':');
      try {
        const response = await http(actors[from], '/api/blocks/' + actors[to].id, 'DELETE');
        assert.ok([200, 404].includes(response.status), 'Unexpected unblock cleanup status');
        blocks.delete(key);
      } catch (error) { errors.push('block cleanup: ' + redact(error.message)); }
    }
    if (privacyChanged) {
      try { success(await http(actors.b, '/api/privacy/me', 'PUT', { allowDirectMessages: true })); }
      catch (error) { errors.push('privacy cleanup: ' + redact(error.message)); }
    }
    assert.deepEqual(errors, [], 'Fixture cleanup must finish');
    return { callsEnded: createdCallIds.size, accountDeletion: 'No public deletion API; two run-scoped local fixture accounts remain' };
  });
}

if (args.includes('--help')) {
  console.log('node scripts/test-dm-block.mjs [--base-url http://localhost:18080] [--report reports/dm-block-report.json]');
  console.log('Creates fresh local A/B fixtures and tests both block directions, reciprocal unblock, Chat Feign enforcement, call acceptance revalidation and restored privacy. Never requests LiveKit media access.');
} else {
  try { await main(); }
  catch (error) { cases.push({ name: 'DM block runner setup', status: 'failed', durationMs: 0, error: redact(error?.message ?? error) }); }
  finally {
    await cleanup();
    const summary = { total: cases.length, passed: cases.filter((item) => item.status === 'passed').length, failed: cases.filter((item) => item.status === 'failed').length };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify({
      suite: 'DM block policy across User and Chat APIs',
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl: base,
      runId,
      scope: 'Isolated local Gateway, Identity, User and Chat with real PostgreSQL/MongoDB/Redis/Feign; no LiveKit media/provider calls',
      fixture: { actors: Object.keys(actors), conversationId },
      summary,
      cases,
      requests,
    }, null, 2) + '\n', 'utf8');
    console.log('DM block integration: ' + summary.passed + ' passed, ' + summary.failed + ' failed. Report: ' + reportPath);
    if (summary.failed) process.exitCode = 1;
  }
}
