import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { createWebServer } from '../src/web/server.js';
import { sse } from '../src/adapter.js';
import type { Adapter } from '../src/types.js';
import type { EventPayload } from '../src/web/transport.js';
import { temporaryAdventures } from './helpers/adventures.js';
import { ScriptedModel } from './helpers/scripted-model.js';

test('SSE batches text into suffix patches, refreshes snapshots and replaces the baseline on restore and reconnect', async t => {
  let signalEntered!: () => void, releaseModel!: () => void;
  const entered = { promise: new Promise<void>(resolve => { signalEntered = resolve; }), resolve: () => signalEntered() };
  const release = { promise: new Promise<void>(resolve => { releaseModel = resolve; }), resolve: () => releaseModel() };
  t.after(() => release.resolve());
  const memo = JSON.stringify({ currentSituation: '秘密', necessaryFacts: '石壁', unfinishedActionsAndIntent: '等待' });
  const model: Adapter = { async *generate() {
    yield { type: 'text', text: '河畔。\n' };
    yield { type: 'text', text: memo };
    entered.resolve(); await release.promise;
    yield { type: 'text', text: '\n请选择。' };
    yield { type: 'usage', input: 100, output: 20 };
  } };
  const { open } = temporaryAdventures(t, 'witcher-sse-patch-');
  const service = open({ main: model, combat: new ScriptedModel() }); const id = service.create('增量故事').id;
  const saved = await service.save(id, '起点');
  const server = createWebServer(service, join(import.meta.dirname, '../../Frontend/dist'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release.resolve(); server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/adventures/${id}/events`;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(url, { signal: controller.signal });
  const frames = sse(response.body!);
  const next = async (): Promise<EventPayload> => {
    const timeout = setTimeout(() => controller.abort(), 3000);
    try { const frame = await frames.next(); assert.equal(frame.done, false); return JSON.parse(frame.value!); }
    finally { clearTimeout(timeout); }
  };
  const baseline = await next(); assert.equal(baseline.type, 'baseline');
  service.submit(id, 'stream', '继续'); await entered.promise;
  let cursor = baseline.type === 'baseline' ? baseline.state.sequence : -1;
  let batch: Extract<EventPayload, { type: 'delta' }> | undefined;
  while (!batch) {
    const payload = await next(); assert.equal(payload.type, 'delta');
    if (payload.type !== 'delta') throw new Error('Unexpected baseline');
    assert.equal(payload.after, cursor); cursor = payload.events.at(-1)!.id;
    if (payload.events.some(event => event.type === 'request.chunk')) batch = payload;
  }
  assert.equal(batch.events.filter(event => event.type === 'request.chunk').length, 2);
  assert.equal(batch.patch.stream?.text, '河畔。');
  assert.ok(!('state' in batch)); assert.ok(!('rules' in batch.patch.values)); assert.ok(!('saves' in batch.patch.values));
  assert.ok(batch.events.some(event => event.type === 'request.chunk' && event.chunk.type === 'text' && event.chunk.text.includes('currentSituation')));
  release.resolve(); await service.idle(id);
  let finished = false;
  while (!finished) {
    const payload = await next(); assert.equal(payload.type, 'delta');
    if (payload.type === 'delta') { assert.equal(payload.after, cursor); cursor = payload.events.at(-1)!.id; finished = payload.events.some(event => event.type === 'operation.end'); }
  }
  const snapshot = await service.save(id, '新快照');
  let savedPatch = false;
  while (!savedPatch) {
    const payload = await next();
    if (payload.type === 'delta' && payload.events.some(event => event.type === 'snapshot.saved')) {
      savedPatch = true; assert.ok(payload.patch.values.saves?.some(save => save.id === snapshot.id));
    }
  }
  await service.restore(id, saved.id);
  let restored: Extract<EventPayload, { type: 'baseline' }> | undefined;
  while (!restored) { const payload = await next(); if (payload.type === 'baseline') restored = payload; }
  assert.deepEqual(restored.state.story, []); assert.ok(restored.state.sequence > cursor);
  controller.abort();
  const reconnectController = new AbortController(); t.after(() => reconnectController.abort());
  const reconnected = await fetch(url, { signal: reconnectController.signal });
  const initial = JSON.parse((await sse(reconnected.body!).next()).value!) as EventPayload;
  assert.equal(initial.type, 'baseline'); if (initial.type === 'baseline') assert.deepEqual(initial.state.story, []);
});
