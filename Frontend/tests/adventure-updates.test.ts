import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAdventureUpdate } from '../src/adventure-updates.ts';
import { streamPatch } from '../../RpgAgent/src/web/transport.ts';
import type { AdventureState, EventPayload, ExecutionEvent } from '../src/types.ts';

const state = (): AdventureState => ({ id: 'adventure', name: '河畔', createdAt: '', phase: 'waiting', queued: 0, error: undefined, sequence: 0,
  story: [], stream: undefined, rules: { revision: 0, owner: 'narrative', resources: { hope: 2, fear: 0 }, character: null },
  character: undefined, battle: null, awaiting: null, saves: [], settingsRevision: 0 });
const event = (id: number): ExecutionEvent => ({ id, adventureId: 'adventure', time: '', type: 'notice', text: '' });
const delta = (id: number, stream: Extract<EventPayload, { type: 'delta' }>['patch']['stream']): EventPayload => ({ version: 2, type: 'delta', history: false,
  after: id - 1, events: [event(id)], patch: { values: { sequence: id }, storyAdded: [], stream } });

test('baseline, suffix updates, retractions and completion match the current story without replaying history', () => {
  const original = state(); original.error = '先前失败';
  let update = applyAdventureUpdate(null, 0, { version: 2, type: 'baseline', history: true, state: original, events: [] });
  assert.equal(update.history, true);
  update = applyAdventureUpdate(update.state, update.cursor, delta(1, { requestId: 'reply', agent: 'main', from: 0, text: '河畔  ' }));
  assert.equal(update.state.stream?.text, '河畔  ');
  update = applyAdventureUpdate(update.state, update.cursor, delta(2, streamPatch(update.state.stream, { requestId: 'reply', agent: 'main', text: '河畔' })));
  assert.equal(update.state.stream?.text, '河畔');
  const completion = delta(3, null) as Extract<EventPayload, { type: 'delta' }>;
  completion.patch.values.error = null; completion.patch.storyAdded = [{ id: 'reply', role: 'assistant', text: '河畔' }];
  update = applyAdventureUpdate(update.state, update.cursor, completion);
  assert.equal(update.state.error, undefined); assert.equal(update.state.stream, undefined); assert.equal(update.state.story.length, 1);
  const repeated = applyAdventureUpdate(update.state, update.cursor, completion);
  assert.equal(repeated.events.length, 0); assert.equal(repeated.state.story.length, 1);
});

test('gaps and invalid stream offsets are rejected before applying any state', () => {
  const original = state();
  assert.throws(() => applyAdventureUpdate(original, 0, delta(2, null)), /序号不连续/);
  assert.throws(() => applyAdventureUpdate(original, 0, delta(1, { requestId: 'reply', from: 1, text: 'bad' })), /位置无效/);
  assert.equal(original.sequence, 0); assert.deepEqual(original.story, []);
});

test('restored and reconnected baselines replace future story and accept a monotonic transport cursor', () => {
  const future = state(); future.sequence = 10; future.story = [{ id: 'future', role: 'assistant', text: '未来' }];
  const past = state(); past.sequence = 11; past.story = [{ id: 'past', role: 'assistant', text: '过去' }];
  const restored = applyAdventureUpdate(future, 10, { version: 2, type: 'baseline', history: true, state: past, events: [event(1)] });
  assert.equal(restored.cursor, 11); assert.equal(restored.history, true); assert.deepEqual(restored.state.story, past.story);
  const next = applyAdventureUpdate(restored.state, restored.cursor, delta(12, null));
  assert.equal(next.cursor, 12);
});
