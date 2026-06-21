import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelDirectories } from '../src/model-directory.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
test('both Agents share one in-flight directory request', async () => {
  const response = deferred<{ models: { id: string }[] }>();
  const requests: string[] = [];
  const directories = new ModelDirectories(id => { requests.push(id); return response.promise; }, () => {});
  const first = directories.load('a'); await directories.load('a');
  response.resolve({ models: [{ id: 'shared' }] }); await first;
  assert.deepEqual(requests, ['a']);
  assert.deepEqual(directories.get('a')?.models, ['shared']);
});
test('Provider results never overwrite each other when responses arrive out of order', async () => {
  const a = deferred<{ models: { id: string }[] }>(), b = deferred<{ models: { id: string }[] }>();
  const requests: string[] = [];
  const directories = new ModelDirectories(id => { requests.push(id); return id === 'a' ? a.promise : b.promise; }, () => {});
  const loadingA = directories.load('a'); await directories.load('a');
  const loadingB = directories.load('b');
  b.resolve({ models: [{ id: 'b-model' }] }); await loadingB;
  a.resolve({ models: [{ id: 'a-model' }] }); await loadingA;
  assert.deepEqual(requests, ['a', 'b']);
  assert.deepEqual(directories.get('b')?.models, ['b-model']);
  assert.deepEqual(directories.get('a')?.models, ['a-model']);
});
test('refresh wins over an old request arriving later', async () => {
  const old = deferred<{ models: { id: string }[] }>();
  let calls = 0, changes = 0;
  const directories = new ModelDirectories(() => ++calls === 1 ? old.promise : Promise.resolve({ models: [{ id: 'new' }] }), () => changes++);
  const pending = directories.load('a'); await directories.load('a', true);
  old.resolve({ models: [{ id: 'old' }] }); await pending;
  assert.deepEqual(directories.get('a')?.models, ['new']);
});
test('closed settings ignore late directory results', async () => {
  let changes = 0;
  const late = deferred<{ models: { id: string }[] }>();
  const closed = new ModelDirectories(() => late.promise, () => changes++);
  const closing = closed.load('a'); closed.dispose(); const before = changes;
  late.resolve({ models: [{ id: 'late' }] }); await closing;
  assert.equal(changes, before);
  assert.deepEqual(closed.get('a')?.models, []);
});
for (const failure of ['empty', 'HTTP 503']) {
  test(`${failure} catalogue remains refreshable`, async () => {
    let recovered = false;
    const directories = new ModelDirectories(async () => {
      if (recovered) return { models: [{ id: 'recovered' }] };
      if (failure === 'HTTP 503') throw new Error(failure);
      return { models: [] };
    }, () => {});
    await directories.load('a');
    assert.match(directories.get('a')!.error!, failure === 'empty' ? /空模型目录/ : /HTTP 503/);
    assert.equal(directories.get('a')!.loading, false);
    recovered = true; await directories.load('a', true);
    assert.deepEqual(directories.get('a')!.models, ['recovered']);
    assert.ok(!directories.get('a')!.error);
  });
}
