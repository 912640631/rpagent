import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diceResults } from '../src/dice-results.ts';

test('recovered narrative dice remain in history but never enter the live animation queue', () => {
  const event = { id: 12, type: 'tool.result', call: { name: 'narrative_roll' },
    result: { recovered: true, ruleStepAlreadyCommitted: true, result: { dice: { hope: 8, fear: 3 }, total: 11 } } };
  const [history] = diceResults(event);
  assert.ok(history);
  assert.deepEqual(history.dice, [{ kind: 'hope', value: 8, sides: 12 }, { kind: 'fear', value: 3, sides: 12 }]);
  assert.equal(history.total, 11);
  assert.deepEqual(diceResults(event, { forAnimation: true }), []);
  const live = { ...event, result: { result: event.result.result } };
  assert.deepEqual(diceResults(live, { forAnimation: true }), diceResults(live));
});

test('damage history shows authoritative totals without fabricating individual rolls', () => {
  const event = { id: 13, type: 'tool.result', result: { events: [{ type: 'damage', details: { rolled: 9 } }] } };
  const [result] = diceResults(event);
  assert.ok(result);
  assert.equal(result.total, 9); assert.deepEqual(result.dice, []);
});
