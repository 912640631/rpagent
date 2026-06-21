import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { commandSchema, validCommand } from '../src/command.js';
import { actionId, findActionRule, parseActionId } from '../src/action-rules.js';
import { createBattle, getOptions } from '../src/engine.js';
import { makeSessionView } from '../src/session-view.js';
import { simulateBattle } from '../src/policy.js';
import { monsterIds } from '../src/data.js';

export const commandCases: [unknown, boolean][] = [
  [{ type: 'action', id: 'sword:normal' }, true],
  [{ type: 'action', id: 'sign:aard', part: 'head', choice: 'push', advantage: 'none', useHopeAdvantage: true, empowerHit: false, empowerDamage: false }, true],
  [{ type: 'decision', choice: 'skip' }, true],
  [{ type: 'action' }, false], [{ type: 'decision' }, false],
  [{ type: 'decision', choice: 'skip', id: 'sword:normal' }, false],
  [{ type: 'action', id: 'a', extra: 1 }, false],
  [{ type: 'action', id: 1 }, false], [{ type: 'action', id: 'a', advantage: 'bad' }, false],
  [{ type: 'action', id: 'a', empowerHit: 1 }, false], [null, false], [[], false]
];
// Independent JSON-schema evaluation of the wire subset, also used on actual registered tools.
export function accepts(schema: any, value: any): boolean {
  if (schema.oneOf) return schema.oneOf.filter((branch: any) => accepts(branch, value)).length === 1;
  if ('const' in schema) return value === schema.const;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    schema.required.every((key: string) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => schema.properties[key] && accepts(schema.properties[key], value[key]));
  return typeof value === schema.type;
}
test('Command wire schema and execution validator agree', () => {
  for (const [value, expected] of commandCases) {
    assert.equal(accepts(commandSchema, value), expected, JSON.stringify(value));
    assert.equal(validCommand(value), expected, JSON.stringify(value));
  }
});
test('all option identifiers resolve through the shared rule mapping and retain descriptions', () => {
  for (const id of monsterIds) for (const side of ['geralt', 'monster'] as const) {
    const state = createBattle(id); state.initiative = side; state.fear = 12;
    state.combatants[side].statuses.burning = 1;
    for (const option of getOptions(state)) {
      const found = findActionRule(state, option.id); assert.ok(found, option.id);
      assert.equal(actionId(found.category, found.key), option.id);
      assert.equal(makeSessionView(state).options.find(item => item.id === option.id)?.name, option.name);
    }
  }
  assert.equal(findActionRule({ monsterId: 'wolf' }, 'sword:toString'), undefined);
  for (const id of ['normal', 'sword:', 'sword:normal:extra', 'unknown:a']) assert.equal(parseActionId(id), undefined);
});
test('complete battle results match the pre-refactor baseline for every monster and seed', () => {
  const baseline = JSON.parse(readFileSync(new URL('./battle-baseline.json', import.meta.url), 'utf8')) as { id: string; seed: number; hash: string }[];
  for (const row of baseline) {
    const result = simulateBattle(createBattle(row.id, row.seed));
    assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), row.hash, `${row.id}/${row.seed}`);
  }
});
