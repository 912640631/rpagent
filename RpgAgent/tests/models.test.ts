import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { providerModels } from '../src/web/models.js';
import { AdventureService } from '../src/web/service.js';
import { createWebServer } from '../src/web/server.js';
import type { Provider } from '../src/types.js';

async function endpoint(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const provider = (baseURL: string): Provider => ({ protocol: 'openai-chat', baseURL, defaultModel: 'default', contextTokens: 32768, apiKey: 'directory-secret' });

test('catalogue uses saved credentials, deduplicates and sorts IDs without forwarding secrets', async t => {
  const upstream = await endpoint(t, (req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer directory-secret');
    res.end(JSON.stringify({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }] }));
  });
  const root = mkdtempSync(join(tmpdir(), 'witcher-models-'));
  const service = new AdventureService(root);
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const settings = structuredClone(service.settings.value); settings.providers.local = provider(upstream + '/v1/'); service.settings.update(settings);
  const server = createWebServer(service, root);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const response = await fetch(url + '/api/providers/local/models');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: [{ id: 'a' }, { id: 'z' }] });
});
test('an unknown Provider catalogue request is rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'witcher-models-'));
  const service = new AdventureService(root);
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const server = createWebServer(service, root);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await fetch(url + '/api/providers/missing/models')).status, 400);
});
test('an empty catalogue is valid', async t => {
  const url = await endpoint(t, (_req, res) => res.end('{"data":[]}'));
  assert.deepEqual(await providerModels(provider(url)), { models: [] });
});
for (const invalid of ['not json', '{"models":[]}', '{"data":[{"id":1}]}', '{"data":[null]}', '{"data":[{"id":" "}]}']) {
  test(`malformed catalogue ${invalid} is rejected`, async t => {
    const url = await endpoint(t, (_req, res) => res.end(invalid));
    await assert.rejects(providerModels(provider(url)), /无效/);
  });
}
for (const status of [401, 404, 503]) {
  test(`catalogue HTTP ${status} exposes a safe error without the response body`, async t => {
    const url = await endpoint(t, (_req, res) => { res.statusCode = status; res.end('directory-secret private response'); });
    await assert.rejects(providerModels(provider(url)), error => error instanceof Error && error.message === `模型目录返回 HTTP ${status}`);
  });
}
for (const present of [false, true]) {
  test(present ? 'environment credentials take precedence over a saved key' : 'missing environment credentials fail before HTTP', async t => {
    const variable = 'WITCHER_DIRECTORY_TEST_KEY';
    const original = process.env[variable];
    t.after(() => { if (original === undefined) delete process.env[variable]; else process.env[variable] = original; });
    let requests = 0;
    const url = await endpoint(t, (req, res) => { requests++; assert.equal(req.headers.authorization, 'Bearer env-secret'); res.end('{"data":[]}'); });
    if (present) {
      process.env[variable] = 'env-secret';
      await providerModels({ ...provider(url), apiKeyEnv: variable }); assert.equal(requests, 1);
    } else {
      delete process.env[variable];
      await assert.rejects(providerModels({ ...provider(url), apiKeyEnv: variable }), /环境变量/);
      assert.equal(requests, 0);
    }
  });
}
test('catalogue requests enforce a 10 second deadline and expose safe timeout errors', async t => {
  const url = await endpoint(t, () => {});
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 10_000); return timeout(10); });
  await assert.rejects(providerModels(provider(url)), /连接失败或超时/);
});
