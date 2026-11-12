import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issues = [];
const warnings = [];
const collectionFiles = ['Kirenz-API.postman_collection.json', 'Kirenz-Integration.postman_collection.json'];
const environmentFile = 'Kirenz-Local.postman_environment.json';
const postmanLegacyBindings = ['tests', 'globals', 'environment', 'data', 'request', 'responseCookies', 'responseHeaders', 'responseTime', 'responseCode', 'responseBody', 'iteration', 'postman', '_', 'CryptoJS', 'atob', 'btoa', 'tv4', 'xml2Json', 'Backbone', 'cheerio'];
const report = {
  generatedAt: new Date().toISOString(),
  status: 'failed',
  validation: { officialSchema: false, postmanSdk: false, javascriptSyntax: true, sandboxBindings: true, declaredVariables: true, shippedSecrets: true },
  inventories: [],
  collections: [],
  environment: null,
  coverage: { totalEndpoints: 0, coveredEndpoints: 0, missing: [], unexpected: [], duplicates: [] },
  issues,
  warnings
};

function fail(location, message) {
  issues.push({ location, message });
}

async function readJson(relativePath) {
  try {
    const text = await fs.readFile(path.join(root, relativePath), 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(relativePath, error instanceof SyntaxError ? 'Invalid JSON.' : 'File cannot be read.');
    return null;
  }
}

function authType(auth) {
  return auth && typeof auth === 'object' ? auth.type : null;
}

function textOfScript(script) {
  if (Array.isArray(script?.exec)) return script.exec.join('\n');
  return typeof script?.exec === 'string' ? script.exec : '';
}

function eventsOf(value) {
  return Array.isArray(value?.event) ? value.event : [];
}

function variableKeys(value) {
  return Array.isArray(value?.variable) ? value.variable.map(variable => variable?.key).filter(key => typeof key === 'string') : [];
}

function rawUrl(request) {
  if (typeof request?.url === 'string') return request.url;
  return typeof request?.url?.raw === 'string' ? request.url.raw : '';
}

function routePattern(url) {
  const replaced = url.replace(/^\{\{[^{}]+\}\}/, 'https://example.test');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(replaced).pathname);
  } catch {
    return null;
  }
  return pathname.replace(/\{\{[^{}]+\}\}/g, ':value').replace(/\/+$/, '') || '/';
}

function placeholders(text) {
  return [...text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
}

function declarationNames(script) {
  return [...script.matchAll(/pm\.(?:environment|collectionVariables|variables|globals)\.set\s*\(\s*(['"])([^'"]+)\1\s*,/g)].map(match => match[2]);
}

function checkSecrets(value, location) {
  const text = JSON.stringify(value);
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) {
    fail(location, 'Contains a literal JWT; export files must not contain runtime credentials.');
    report.validation.shippedSecrets = false;
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
    fail(location, 'Contains a private key.');
    report.validation.shippedSecrets = false;
  }
}

function checkStoredVariable(variable, location) {
  const key = variable?.key;
  if (typeof key !== 'string' || !key.trim()) {
    fail(location, 'Variable key must be a nonempty string.');
    return;
  }
  const value = variable.value;
  const secretName = /(?:token|password|secret|otp|api[_-]?key)/i.test(key);
  const empty = value === '' || value === null || value === undefined;
  const runtimeExpression = typeof value === 'string' && /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
  const generatedPassword = /password/i.test(key) && typeof value === 'string' && /\{\{\s*(?:run_id|\$randomPassword|\$guid)\s*\}\}/.test(value);
  if (secretName && !empty && !runtimeExpression && !generatedPassword) {
    fail(location, 'Sensitive variable must be empty or generated at runtime; its value is not included in this report.');
    report.validation.shippedSecrets = false;
  }
}

function validateScript(script, location) {
  if (!script || typeof script !== 'object') {
    fail(location, 'Event script is missing.');
    return;
  }
  if (!Array.isArray(script.exec) && typeof script.exec !== 'string') {
    fail(location, 'Script exec must be a string or string array.');
    return;
  }
  if (Array.isArray(script.exec) && script.exec.some(line => typeof line !== 'string')) {
    fail(location, 'Script lines must be strings.');
    return;
  }
  try {
    const source = textOfScript(script);
    new vm.Script(source, { filename: location });
    const legacyDisabled = /^(['"])use sandbox2\1;/.test(source);
    const legacyNames = legacyDisabled ? [] : postmanLegacyBindings;
    const importedNames = [...legacyNames, 'pm', 'Buffer', 'console', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'];
    try {
      new vm.Script('var ' + [...new Set(importedNames)].join(',') + ';\n' + source, { filename: location });
    } catch (error) {
      fail(location, 'Postman sandbox binding conflict: ' + error.message);
      report.validation.sandboxBindings = false;
    }
  } catch (error) {
    fail(location, 'Invalid JavaScript syntax: ' + error.message);
    report.validation.javascriptSyntax = false;
  }
}

const moduleNames = (await fs.readdir(path.join(root, 'modules')).catch(() => [])).filter(name => name.endsWith('.json')).sort();
const endpointMap = new Map();
for (const name of moduleNames) {
  const inventory = await readJson(path.join('modules', name));
  if (!inventory) continue;
  if (!Array.isArray(inventory.endpoints)) {
    fail('modules/' + name, 'Inventory endpoints must be an array.');
    continue;
  }
  report.inventories.push({ file: name, endpoints: inventory.endpoints.length });
  for (const endpoint of inventory.endpoints) {
    if (typeof endpoint.id !== 'string' || !endpoint.id) {
      fail('modules/' + name, 'Endpoint has no ID.');
      continue;
    }
    if (endpointMap.has(endpoint.id)) fail('modules/' + name, 'Duplicate inventory endpoint ID: ' + endpoint.id);
    else endpointMap.set(endpoint.id, endpoint);
    if (!endpoint.method || !endpoint.path) fail('modules/' + name + ':' + endpoint.id, 'Endpoint method/path is required.');
  }
}
if (!moduleNames.length) fail('modules', 'No endpoint inventories found.');
report.coverage.totalEndpoints = endpointMap.size;

const environment = await readJson(environmentFile);
const environmentVariables = new Set();
if (environment) {
  checkSecrets(environment, environmentFile);
  if (!Array.isArray(environment.values)) fail(environmentFile, 'Environment values must be an array.');
  else {
    for (const [index, variable] of environment.values.entries()) {
      const location = environmentFile + ':values[' + index + ']';
      checkStoredVariable(variable, location);
      if (environmentVariables.has(variable.key)) fail(location, 'Duplicate environment variable key: ' + variable.key);
      environmentVariables.add(variable.key);
      if (/(?:^base_url$|_base_url$)/i.test(variable.key) && typeof variable.value === 'string' && variable.value) {
        try {
          const parsed = new URL(variable.value);
          if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) fail(location, 'The shipped local environment must target localhost.');
          if (parsed.username || parsed.password) fail(location, 'URL credentials must not be shipped.');
        } catch {
          if (!variable.value.includes('{{')) fail(location, 'Base URL is invalid.');
        }
      }
    }
    report.environment = { file: environmentFile, name: environment.name, variables: environment.values.length };
  }
}

let officialValidate;
let Collection;
try {
  const schema = await readJson('schema/collection.v2.1.schema.json');
  if (schema) {
    const AjvDraft04 = require('ajv-draft-04').default ?? require('ajv-draft-04');
    const ajv = new AjvDraft04({
      allErrors: true,
      strict: false,
      logger: { log() {}, error() {}, warn(message) { warnings.push({ location: 'official-schema', message: String(message) }); } }
    });
    officialValidate = ajv.compile(schema);
    report.validation.officialSchema = true;
  }
} catch (error) {
  fail('schema/collection.v2.1.schema.json', 'Cannot initialize official Draft-04 schema validator: ' + error.message);
}
try {
  Collection = require('postman-collection').Collection;
  report.validation.postmanSdk = typeof Collection === 'function';
  if (!report.validation.postmanSdk) fail('dependencies', 'Postman Collection SDK is unavailable.');
} catch {
  fail('dependencies', 'Postman Collection SDK is unavailable; run npm ci.');
}

const apiOccurrences = new Map();
for (const filename of collectionFiles) {
  const collection = await readJson(filename);
  if (!collection) continue;
  checkSecrets(collection, filename);
  const summary = { file: filename, name: collection.info?.name, requests: 0, scripts: 0, sdkRequests: 0 };
  report.collections.push(summary);
  if (!collection.info?.name || !Array.isArray(collection.item)) fail(filename, 'Collection info.name and item array are required.');
  if (collection.info?.schema !== 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json') fail(filename, 'Collection must declare the official v2.1 schema URL.');
  if (officialValidate && !officialValidate(collection)) {
    for (const error of officialValidate.errors ?? []) fail(filename + ':' + error.instancePath, 'Schema: ' + error.message);
  }
  const declared = new Set([...environmentVariables, ...variableKeys(collection)]);
  const scriptTexts = [];
  function inspectEvents(node, location) {
    for (const [index, event] of eventsOf(node).entries()) {
      summary.scripts++;
      const scriptLocation = location + ':event[' + index + ']';
      validateScript(event.script, scriptLocation);
      scriptTexts.push(textOfScript(event.script));
      for (const key of declarationNames(textOfScript(event.script))) declared.add(key);
    }
  }
  inspectEvents(collection, filename);
  function collectDeclarations(items, parentLocation) {
    if (!Array.isArray(items)) return;
    for (const [index, item] of items.entries()) {
      const location = parentLocation + '/item[' + index + ']';
      for (const key of variableKeys(item)) declared.add(key);
      inspectEvents(item, location);
      if (item.item) collectDeclarations(item.item, location);
    }
  }
  collectDeclarations(collection.item, filename);
  for (const [index, variable] of (collection.variable ?? []).entries()) checkStoredVariable(variable, filename + ':variable[' + index + ']');
  for (const key of placeholders(JSON.stringify(collection))) {
    if (key.startsWith('$')) continue;
    if (!declared.has(key)) {
      fail(filename, 'Undeclared placeholder: {{' + key + '}}');
      report.validation.declaredVariables = false;
    }
  }
  const itemIds = new Set();
  function inspectItems(items, inheritedAuth, parentLocation) {
    if (!Array.isArray(items)) return;
    for (const [index, item] of items.entries()) {
      const location = parentLocation + '/item[' + index + ']';
      if (typeof item.name !== 'string' || !item.name.trim()) fail(location, 'Item name is required.');
      if (item.id) {
        if (itemIds.has(item.id)) fail(location, 'Duplicate collection item ID.');
        itemIds.add(item.id);
      }
      const currentAuth = item.auth ?? inheritedAuth;
      if (Array.isArray(item.item)) {
        inspectItems(item.item, currentAuth, location);
        continue;
      }
      if (!item.request || typeof item.request !== 'object') {
        fail(location, 'Request must be an object.');
        continue;
      }
      summary.requests++;
      const request = item.request;
      const effectiveAuth = request.auth ?? currentAuth;
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method)) fail(location, 'Invalid or missing HTTP method.');
      const url = rawUrl(request);
      const route = routePattern(url);
      if (!url || !route || !/^(?:https?:\/\/|\{\{[^{}]+\}\})/.test(url)) fail(location, 'Request URL must have an HTTP base or declared base variable.');
      if (typeof request.body?.raw === 'string' && request.body?.options?.raw?.language === 'json') {
        try { JSON.parse(request.body.raw); } catch { fail(location, 'Raw JSON body is invalid JSON.'); }
      }
      if (request.body?.mode === 'formdata' && !Array.isArray(request.body.formdata)) fail(location, 'Multipart body requires a formdata array.');
      for (const header of request.header ?? []) {
        if (/^authorization$/i.test(header.key) && header.value && !header.value.includes('{{')) fail(location, 'Authorization header must use a variable, not a literal credential.');
      }
      if (authType(effectiveAuth) === 'bearer') {
        for (const value of effectiveAuth.bearer ?? []) {
          if (value.key === 'token' && typeof value.value === 'string' && value.value && !value.value.includes('{{')) fail(location, 'Bearer token must use a variable.');
        }
      }
      if (filename !== collectionFiles[0]) continue;
      const prefix = item.name?.match(/^\[([A-Za-z0-9_-]+)\]/)?.[1];
      const marker = String(request.description ?? item.description ?? '').match(/Endpoint:\s*([A-Za-z0-9_-]+)/)?.[1];
      if (prefix && marker && prefix !== marker) fail(location, 'Name/description endpoint markers disagree.');
      const id = prefix ?? marker;
      if (!id) {
        fail(location, 'API request requires [endpoint_id] name prefix or Endpoint marker.');
        continue;
      }
      apiOccurrences.set(id, (apiOccurrences.get(id) ?? 0) + 1);
      const endpoint = endpointMap.get(id);
      if (!endpoint) continue;
      if (endpoint.method !== request.method) fail(location, 'HTTP method does not match inventory endpoint ' + id);
      if (routePattern('https://example.test' + endpoint.path) !== route) fail(location, 'URL path does not match inventory endpoint ' + id);
      const effectiveType = authType(effectiveAuth);
      const authorizationHeader = (request.header ?? []).some(header => /^authorization$/i.test(header.key) && !header.disabled && header.value?.includes('{{'));
      if (endpoint.auth === 'none') {
        if (effectiveType !== 'noauth' && (effectiveType || authorizationHeader)) fail(location, 'Anonymous catalog request must disable inherited authorization.');
      } else if (effectiveType !== 'bearer' && !authorizationHeader) {
        fail(location, 'Authenticated catalog request requires bearer-variable authorization.');
      }
    }
  }
  inspectItems(collection.item, collection.auth, filename);
  if (Collection) {
    try {
      const sdk = new Collection(collection);
      const normalized = sdk.toJSON();
      function countRequests(items) {
        return (items ?? []).reduce((count, item) => count + (item.item ? countRequests(item.item) : item.request ? 1 : 0), 0);
      }
      summary.sdkRequests = countRequests(normalized.item);
      if (summary.sdkRequests !== summary.requests) fail(filename, 'SDK round-trip changed the request count.');
    } catch (error) {
      fail(filename, 'Postman SDK cannot parse collection: ' + error.message);
    }
  }
}
for (const id of endpointMap.keys()) {
  const count = apiOccurrences.get(id) ?? 0;
  if (!count) report.coverage.missing.push(id);
  else report.coverage.coveredEndpoints++;
  if (count > 1) report.coverage.duplicates.push({ id, count });
}
for (const id of apiOccurrences.keys()) if (!endpointMap.has(id)) report.coverage.unexpected.push(id);
for (const id of report.coverage.missing) fail('coverage', 'Missing API request for ' + id);
for (const item of report.coverage.duplicates) fail('coverage', 'Duplicate API request for ' + item.id);
for (const id of report.coverage.unexpected) fail('coverage', 'Unknown API endpoint ID: ' + id);
if (!report.validation.officialSchema) fail('validation', 'Official schema validation did not run.');
if (!report.validation.postmanSdk) fail('validation', 'Postman SDK validation did not run.');
report.status = issues.length ? 'failed' : 'passed';
await fs.mkdir(path.join(root, 'reports'), { recursive: true });
await fs.writeFile(path.join(root, 'reports', 'collection-coverage.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  status: report.status,
  inventoryEndpoints: report.coverage.totalEndpoints,
  coveredEndpoints: report.coverage.coveredEndpoints,
  collections: report.collections.map(({ file, requests, scripts }) => ({ file, requests, scripts })),
  errors: issues.length,
  warnings: warnings.length,
  report: 'reports/collection-coverage.json'
}, null, 2));
if (issues.length) {
  for (const issue of issues) console.error(issue.location + ': ' + issue.message);
  process.exitCode = 1;
}
