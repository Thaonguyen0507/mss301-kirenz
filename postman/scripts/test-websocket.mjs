import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const envFile = path.resolve(option('--environment', path.join(projectDir, '.local/runtime.postman_environment.json')));
const reportFile = path.resolve(option('--report', path.join(projectDir, 'reports/websocket-report.json')));
const timeoutMs = Math.max(1000, Math.min(30000, Number(option('--timeout-ms', '8000')) || 8000));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = new Date().toISOString();
const cases = [];
const clients = [];
let secretValues = [];
let baseUrl;
let conversationId;
let userIds;

function redact(value) {
  let output = String(value ?? '');
  for (const secret of secretValues) output = output.split(secret).join('[redacted]');
  return output
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .slice(0, 1200);
}

function localUrl(value, label) {
  const url = new URL(value);
  assert.ok(['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol), `${label} must use HTTP or WebSocket`);
  assert.ok(['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname), `${label} must point to Docker localhost; production execution is disabled`);
  assert.equal(url.username, '', `${label} must not contain credentials`);
  assert.equal(url.password, '', `${label} must not contain credentials`);
  assert.equal(url.search, '', `${label} must not contain a query string`);
  assert.equal(url.hash, '', `${label} must not contain a fragment`);
  return url;
}

async function runCase(name, fn, options = {}) {
  const start = Date.now();
  if (options.skip) {
    const result = { name, status: 'skipped', durationMs: 0, reason: options.skip };
    cases.push(result);
    console.log(`SKIP ${name}: ${options.skip}`);
    return null;
  }
  try {
    const details = await fn();
    const result = { name, status: 'passed', durationMs: Date.now() - start, ...(details ? { details } : {}) };
    cases.push(result);
    console.log(`PASS ${name}`);
    return details ?? true;
  } catch (error) {
    const result = { name, status: 'failed', durationMs: Date.now() - start, error: redact(error?.message ?? error) };
    if (options.findingId) result.findingId = options.findingId;
    cases.push(result);
    console.log(`FAIL ${name}: ${result.error}`);
    return null;
  }
}

const escapeHeader = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll(':', '\\c');
const unescapeHeader = (value) => value.replace(/\\(n|r|c|\\)/g, (_, token) => ({ n: '\n', r: '\r', c: ':', '\\': '\\' })[token]);

class StompSession {
  constructor(label, url, token) {
    this.label = label;
    this.url = url;
    this.token = token;
    this.frames = [];
    this.waiters = new Set();
    this.buffer = '';
    this.sequence = 0;
    this.connected = false;
    this.transportOpened = false;
    this.closed = false;
    this.mode = 'raw';
    this.connectSent = false;
    clients.push(this);
  }

  record(event) {
    event.sequence = ++this.sequence;
    this.frames.push(event);
    if (this.frames.length > 300) this.frames.shift();
    for (const waiter of [...this.waiters]) {
      if (event.sequence > waiter.after && waiter.match(event)) waiter.finish(null, event);
      else if (event.kind === 'close' || event.kind === 'transport-error') waiter.finish(new Error(`${this.label}: WebSocket closed before expected frame`));
    }
  }

  mark() { return this.sequence; }

  waitFor(match, after = 0, limit = timeoutMs) {
    const existing = this.frames.find((event) => event.sequence > after && match(event));
    if (existing) return Promise.resolve(existing);
    if (this.closed) return Promise.reject(new Error(`${this.label}: WebSocket is closed`));
    return new Promise((resolve, reject) => {
      const waiter = { match, after, timer: null, finish: null };
      waiter.finish = (error, event) => {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        error ? reject(error) : resolve(event);
      };
      waiter.timer = setTimeout(() => waiter.finish(new Error(`${this.label}: expected STOMP frame not received within ${limit} ms`)), limit);
      this.waiters.add(waiter);
    });
  }

  receive(data) {
    const text = data.toString();
    if (text === 'o') {
      this.mode = 'sockjs';
      this.sendConnect();
      return;
    }
    if (text === 'h') return;
    if (text.startsWith('c[')) {
      this.ws.close();
      return;
    }
    if (text.startsWith('a[')) {
      for (const frame of JSON.parse(text.slice(1))) this.parse(frame);
      return;
    }
    this.parse(text);
  }

  parse(text) {
    this.buffer += text;
    while (this.buffer.includes('\0')) {
      const end = this.buffer.indexOf('\0');
      const raw = this.buffer.slice(0, end).replace(/^[\r\n]+/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!raw) continue;
      const separator = raw.search(/\r?\n\r?\n/);
      const headerText = separator < 0 ? raw : raw.slice(0, separator);
      const separatorLength = separator >= 0 && raw[separator] === '\r' ? 4 : 2;
      const body = separator < 0 ? '' : raw.slice(separator + separatorLength);
      const [command, ...headerLines] = headerText.split(/\r?\n/);
      const headers = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon >= 0) headers[unescapeHeader(line.slice(0, colon))] = unescapeHeader(line.slice(colon + 1));
      }
      const frame = { kind: 'frame', command, headers, body };
      if (command === 'CONNECTED') this.connected = true;
      if (command === 'MESSAGE') {
        try { frame.json = JSON.parse(body); } catch { frame.json = null; }
      }
      this.record(frame);
    }
    if (/^[\r\n]*$/.test(this.buffer)) this.buffer = '';
  }

  send(command, headers = {}, body = '') {
    assert.equal(this.ws?.readyState, WebSocket.OPEN, `${this.label}: WebSocket is not open`);
    const frame = `${command}\n${Object.entries(headers).map(([key, value]) => `${escapeHeader(key)}:${escapeHeader(value)}`).join('\n')}\n\n${body}\0`;
    this.ws.send(this.mode === 'sockjs' ? JSON.stringify([frame]) : frame);
  }

  sendConnect() {
    if (this.connectSent || this.ws?.readyState !== WebSocket.OPEN) return;
    this.connectSent = true;
    this.send('CONNECT', {
      'accept-version': '1.2,1.1',
      host: new URL(this.url).hostname,
      'heart-beat': '0,0',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    });
  }

  async connect() {
    this.ws = new WebSocket(this.url, ['v12.stomp', 'v11.stomp'], { handshakeTimeout: timeoutMs });
    this.ws.on('open', () => {
      this.transportOpened = true;
      this.connectTimer = setTimeout(() => {
        try { this.sendConnect(); } catch (error) { this.record({ kind: 'transport-error', message: redact(error.message) }); }
      }, 75);
    });
    this.ws.on('message', (data) => {
      try { this.receive(data); } catch (error) { this.record({ kind: 'transport-error', message: redact(error.message) }); }
    });
    this.ws.on('error', (error) => this.record({ kind: 'transport-error', message: redact(error.message) }));
    this.ws.on('close', (code) => {
      this.closed = true;
      this.connected = false;
      clearTimeout(this.connectTimer);
      this.record({ kind: 'close', code });
    });
    const frame = await this.waitFor((event) => event.command === 'CONNECTED' || event.command === 'ERROR');
    if (frame.command !== 'CONNECTED') throw new Error(`${this.label}: STOMP CONNECT rejected`);
    return this;
  }

  async subscribe(destination, id) {
    this.send('SUBSCRIBE', { id, destination, ack: 'auto' });
    await pause(150);
    return id;
  }

  publish(destination, payload) {
    this.send('SEND', { destination, 'content-type': 'application/json' }, JSON.stringify(payload));
  }

  async close() {
    clearTimeout(this.connectTimer);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.closed = true;
      return;
    }
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => { this.ws.terminate(); finish(); }, 1200);
      this.ws.once('close', finish);
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          if (this.connected) this.send('DISCONNECT');
          this.ws.close(1000);
        } else this.ws.terminate();
      } catch { this.ws.terminate(); finish(); }
    });
    this.closed = true;
    this.connected = false;
    for (const waiter of [...this.waiters]) waiter.finish(new Error(`${this.label}: session cleanup`));
  }
}

async function http(token, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`${method} ${pathname}: response is not JSON (HTTP ${response.status})`); }
  assert.equal(response.status, 200, `${method} ${pathname}: HTTP ${response.status}; ${redact(payload?.message ?? 'request rejected')}`);
  assert.equal(payload.success, true, `${method} ${pathname}: success must be true`);
  return payload.data;
}

async function pollPresence(token, desired, ids, limit = 5000) {
  const deadline = Date.now() + limit;
  let last;
  while (Date.now() < deadline) {
    last = await http(token, 'GET', `/api/presence/status?userIds=${ids.join(',')}`);
    if (ids.every((id) => last?.[id]?.isOnline === desired)) return last;
    await pause(200);
  }
  throw new Error(`Presence did not become ${desired ? 'online' : 'offline'} for both fixture users`);
}

async function main() {
  const parsed = JSON.parse(await readFile(envFile, 'utf8'));
  const values = Array.isArray(parsed.values)
    ? Object.fromEntries(parsed.values.filter((entry) => entry.enabled !== false).map((entry) => [entry.key, entry.value]))
    : parsed;
  secretValues = Object.entries(values).filter(([key, value]) => /token|password|secret|api.?key/i.test(key) && typeof value === 'string' && value.length >= 6).map(([, value]) => value).sort((a, b) => b.length - a.length);
  baseUrl = localUrl(values.base_url || 'http://localhost:18080', 'base_url').toString().replace(/\/$/, '');
  const socket = localUrl(`${baseUrl}/ws/chat/websocket`, 'chat WebSocket');
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = socket.toString();
  const tokens = { a: values.access_token_a, b: values.access_token_b, outsider: values.access_token_outsider };
  userIds = { a: values.user_a_id, b: values.user_b_id, outsider: values.user_outsider_id };
  for (const actor of Object.keys(tokens)) {
    assert.ok(typeof tokens[actor] === 'string' && tokens[actor].length > 20 && !tokens[actor].includes('{{'), `Missing access_token_${actor}; run fixture/login setup first`);
    assert.match(userIds[actor] || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `Missing valid ${actor} fixture user ID`);
  }
  assert.equal(new Set(Object.values(userIds)).size, 3, 'A, B and outsider must be three distinct fixture users');
  const runId = String(values.run_id || crypto.randomUUID()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  conversationId = values.conversation_id;
  let a;
  let b;
  let outsider;
  let lastMessage;
  let ready = false;
  const ensureOutsider = async () => {
    if (!outsider?.connected || outsider.closed) outsider = await new StompSession('outsider', wsUrl, tokens.outsider).connect();
    return outsider;
  };
  const marker = (kind) => `kirenz-ws-${kind}-${runId}-${crypto.randomUUID().slice(0, 8)}`;

  await runCase('Fixture direct conversation resolves through User/Identity services', async () => {
    let conversation;
    if (conversationId) {
      try { conversation = await http(tokens.a, 'GET', `/api/conversations/${encodeURIComponent(conversationId)}`); } catch { conversation = null; }
    }
    if (!conversation || conversation.type !== 'DIRECT') conversation = await http(tokens.a, 'POST', `/api/conversations/direct/${userIds.b}`);
    assert.equal(conversation.type, 'DIRECT');
    assert.ok(conversation.id, 'Conversation must have an ID');
    const participants = conversation.participants || [];
    assert.ok(participants.some((peer) => peer.userId === userIds.a), 'A must be a participant');
    assert.ok(participants.some((peer) => peer.userId === userIds.b), 'B must be a participant');
    assert.ok(!participants.some((peer) => peer.userId === userIds.outsider), 'Outsider must not be a participant');
    assert.ok(participants.every((peer) => peer.username && peer.username !== 'Unknown'), 'Participant profiles must come from Identity service');
    conversationId = conversation.id;
    return { participants: 2, identityProfilesResolved: true };
  });

  await runCase('STOMP CONNECT rejects an unauthenticated client', async () => {
    const unauthenticated = new StompSession('unauthenticated', wsUrl, null);
    let connected = false;
    try { await unauthenticated.connect(); connected = true; } catch { connected = false; }
    await unauthenticated.close();
    assert.equal(unauthenticated.transportOpened, true, 'WebSocket transport was unreachable; authentication rejection was not verified');
    assert.equal(connected, false, 'Unauthenticated CONNECT was accepted');
  });

  await runCase('Two authenticated users connect and subscribe', async () => {
    assert.ok(conversationId, 'Conversation setup failed');
    [a, b] = await Promise.all([
      new StompSession('A', wsUrl, tokens.a).connect(),
      new StompSession('B', wsUrl, tokens.b).connect(),
    ]);
    await Promise.all([
      a.subscribe(`/topic/conversation.${conversationId}`, 'a-conversation'),
      b.subscribe(`/topic/conversation.${conversationId}`, 'b-conversation'),
      b.subscribe('/user/queue/messages', 'b-summary'),
      b.subscribe(`/topic/conversation.${conversationId}.typing`, 'b-typing'),
    ]);
    assert.ok(a.connected && b.connected, 'Both clients must remain connected');
    ready = true;
    return { transport: a.mode === 'sockjs' ? 'SockJS/STOMP' : 'WebSocket/STOMP' };
  });

  await runCase('STOMP sessions update Redis presence visible through gateway HTTP', async () => {
    await pollPresence(tokens.a, true, [userIds.a, userIds.b]);
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await runCase('A message reaches B topic and private unread-summary queue', async () => {
    const content = marker('message');
    const after = b.mark();
    a.publish('/app/chat.send', { conversationId, content, attachments: [] });
    const received = await b.waitFor((event) => event.command === 'MESSAGE' && event.headers.subscription === 'b-conversation' && event.json?.content === content, after);
    const message = received.json;
    assert.equal(message.conversationId, conversationId);
    assert.equal(message.senderId, userIds.a);
    assert.equal(message.type, 'TEXT');
    assert.equal(message.status, 'ACTIVE');
    assert.ok(message.id, 'Delivered message must have a persisted ID');
    assert.ok(message.senderName && !/^Unknown$|^User [0-9a-f]{8}$/i.test(message.senderName), 'Sender name must be resolved from Identity/nickname');
    const summary = await b.waitFor((event) => event.command === 'MESSAGE' && event.headers.subscription === 'b-summary' && event.json?.lastMessage?.messageId === message.id, after);
    assert.equal(summary.json.conversationId, conversationId);
    assert.ok(summary.json.unreadCount >= 1, 'B unread summary must increment');
    lastMessage = message;
    return { fullMessageReceived: true, privateSummaryReceived: true, unreadCountPositive: true };
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await runCase('Delivered STOMP message is persisted and enriched in HTTP history', async () => {
    assert.ok(lastMessage, 'Message delivery did not succeed');
    const history = await http(tokens.a, 'GET', `/api/messages/${conversationId}?page=0&size=50`);
    assert.ok(Array.isArray(history), 'History must be an array');
    const persisted = history.find((item) => item.id === lastMessage.id);
    assert.ok(persisted, 'WebSocket message missing from Mongo-backed history');
    assert.equal(persisted.content, lastMessage.content);
    assert.equal(persisted.senderId, userIds.a);
    assert.ok(persisted.senderName && persisted.senderName !== 'Unknown');
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await runCase('B HTTP read receipt clears unread count and emits private queue update', async () => {
    const after = b.mark();
    await http(tokens.b, 'POST', `/api/messages/${conversationId}/read`);
    await b.waitFor((event) => event.command === 'MESSAGE' && event.headers.subscription === 'b-summary' && event.json?.conversationId === conversationId && event.json?.unreadCount === 0, after);
    const conversation = await http(tokens.b, 'GET', `/api/conversations/${conversationId}`);
    assert.equal(conversation.unreadCount, 0);
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await runCase('Member typing is delivered to B typing topic', async () => {
    const after = b.mark();
    a.publish('/app/chat.typing', { conversationId, isTyping: true });
    const event = await b.waitFor((frame) => frame.command === 'MESSAGE' && frame.headers.subscription === 'b-typing' && frame.json?.userId === userIds.a, after);
    assert.equal(event.json.isTyping, true);
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await runCase('Outsider cannot persist or deliver a message to A/B conversation', async () => {
    const client = await ensureOutsider();
    const content = marker('outsider-send');
    const after = b.mark();
    client.publish('/app/chat.send', { conversationId, content, attachments: [] });
    await pause(800);
    const history = await http(tokens.a, 'GET', `/api/messages/${conversationId}?page=0&size=50`);
    assert.ok(!history.some((message) => message.content === content), 'Outsider message was persisted');
    assert.ok(!b.frames.some((frame) => frame.sequence > after && frame.command === 'MESSAGE' && frame.json?.content === content), 'Outsider message was delivered');
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await runCase('Outsider conversation-topic subscription does not leak private messages', async () => {
    const client = await ensureOutsider();
    const outsiderAfter = client.mark();
    await client.subscribe(`/topic/conversation.${conversationId}`, 'outsider-private-conversation');
    const content = marker('privacy-probe');
    const peerAfter = b.mark();
    a.publish('/app/chat.send', { conversationId, content, attachments: [] });
    await b.waitFor((frame) => frame.command === 'MESSAGE' && frame.headers.subscription === 'b-conversation' && frame.json?.content === content, peerAfter);
    await pause(800);
    const leaked = client.frames.some((frame) => frame.sequence > outsiderAfter && frame.command === 'MESSAGE' && frame.json?.content === content);
    assert.equal(leaked, false, 'CHAT-TOPIC-MEMBERSHIP: outsider received a private fixture conversation message');
  }, { skip: ready ? null : 'Authenticated STOMP setup failed', findingId: 'CHAT-TOPIC-MEMBERSHIP' });

  await runCase('Outsider cannot spoof typing in A/B conversation', async () => {
    const client = await ensureOutsider();
    const after = b.mark();
    client.publish('/app/chat.typing', { conversationId, isTyping: true });
    await pause(800);
    const leaked = b.frames.some((frame) => frame.sequence > after && frame.command === 'MESSAGE' && frame.headers.subscription === 'b-typing' && frame.json?.userId === userIds.outsider);
    assert.equal(leaked, false, 'CHAT-TYPING-MEMBERSHIP: outsider typing was broadcast to private conversation members');
  }, { skip: ready ? null : 'Authenticated STOMP setup failed', findingId: 'CHAT-TYPING-MEMBERSHIP' });

  await runCase('Direct broker private-queue subscription is rejected', async () => {
    const client = await ensureOutsider();
    const after = client.mark();
    await client.subscribe('/queue/messages', 'outsider-forbidden-queue');
    await client.waitFor((event) => event.command === 'ERROR' || event.kind === 'close', after, Math.min(timeoutMs, 3000));
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });

  await Promise.allSettled(clients.map((client) => client.close()));
  await runCase('Disconnecting both users clears Redis online presence', async () => {
    const presence = await pollPresence(tokens.a, false, [userIds.a, userIds.b]);
    for (const id of [userIds.a, userIds.b]) assert.ok(Number.isFinite(presence[id].lastSeen), 'Offline fixture must have lastSeen timestamp');
  }, { skip: ready ? null : 'Authenticated STOMP setup failed' });
}

try {
  if (argv.includes('--help')) {
    console.log('node scripts/test-websocket.mjs [--environment .local/runtime.postman_environment.json] [--report reports/websocket-report.json] [--timeout-ms 8000]');
    console.log('Requires localhost Docker gateway and runtime Postman environment with A/B/outsider login tokens + UUIDs. Writes only fixture chat messages and redacted reports.');
  } else {
    await main();
  }
} catch (error) {
  cases.push({ name: 'WebSocket integration runner setup', status: 'failed', durationMs: 0, error: redact(error?.message ?? error) });
  console.error(`FAIL WebSocket integration runner setup: ${redact(error?.message ?? error)}`);
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (!argv.includes('--help')) {
    const summary = {
      total: cases.length,
      passed: cases.filter((item) => item.status === 'passed').length,
      failed: cases.filter((item) => item.status === 'failed').length,
      skipped: cases.filter((item) => item.status === 'skipped').length,
    };
    const report = {
      suite: 'Kirenz real-service STOMP + HTTP integration',
      startedAt,
      finishedAt: new Date().toISOString(),
      environmentFile: path.basename(envFile),
      baseUrl,
      conversationId,
      scope: 'Docker localhost only; real chat/User/Identity, MongoDB and Redis. No LiveKit media/provider claims.',
      summary,
      cases,
    };
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`WebSocket integration: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped. Report: ${reportFile}`);
    if (summary.failed > 0 || summary.skipped > 0) process.exitCode = 1;
  }
}
