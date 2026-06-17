import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createEngine, initialState, resolveFearSpend, resolveRoll } from './index.js';

function fixedDice(hope, fear) {
  const values = [hope, fear];
  return () => values.shift();
}

test('four regular outcomes give the correct resource and narration signals', () => {
  const cases = [
    [9, 4, 10, 'success_hope', true, 'player', 'none', 1, 0],
    [4, 9, 10, 'success_fear', true, 'gm', 'minor_complication', 0, 1],
    [8, 3, 15, 'failure_hope', false, 'gm', 'light', 1, 0],
    [3, 8, 15, 'failure_fear', false, 'gm', 'serious', 0, 1],
  ];
  for (const [hopeDie, fearDie, difficulty, outcome, success, initiative, consequence, hopeGained, fearGained] of cases) {
    const { state, result } = resolveRoll(initialState(), { difficulty }, fixedDice(hopeDie, fearDie));
    assert.equal(result.outcome, outcome);
    assert.equal(result.success, success);
    assert.equal(result.initiative, initiative);
    assert.equal(result.consequence, consequence);
    assert.equal(result.immediateComplication, outcome === 'success_fear');
    assert.equal(result.hopeGained, hopeGained);
    assert.equal(result.fearGained, fearGained);
    assert.equal(state.hope, 2 + hopeGained);
    assert.equal(state.fear, fearGained);
  }
});

test('matching dice automatically succeed below difficulty and grant extra benefit', () => {
  const { state, result } = resolveRoll(initialState(), { difficulty: 30 }, fixedDice(1, 1));
  assert.equal(result.total, 2);
  assert.equal(result.outcome, 'critical_success');
  assert.equal(result.success, true);
  assert.equal(result.extraBenefit, true);
  assert.equal(result.initiative, 'player');
  assert.equal(state.hope, 3);
});

test('advantage costs two Hope before the roll and stacks with modifier', () => {
  const { state, result } = resolveRoll(initialState(), {
    difficulty: 12,
    modifier: 2,
    useHopeAdvantage: true,
  }, fixedDice(4, 3));
  assert.equal(result.total, 12);
  assert.equal(result.hopeSpent, 2);
  assert.equal(result.hopeGained, 1);
  assert.equal(state.hope, 1);
  assert.equal(state.history[0].result.resources.hope, 1);
});

test('resource caps discard excess and Fear gained on a roll can be spent immediately', () => {
  const full = { ...initialState(), hope: 6, fear: 11 };
  const hopeRoll = resolveRoll(full, { difficulty: 10 }, fixedDice(9, 2));
  assert.equal(hopeRoll.result.hopeGained, 0);
  assert.equal(hopeRoll.state.hope, 6);
  const fearRoll = resolveRoll(hopeRoll.state, { difficulty: 10 }, fixedDice(2, 9));
  assert.equal(fearRoll.result.fearGained, 1);
  assert.equal(fearRoll.state.fear, 12);
  const spent = resolveFearSpend(fearRoll.state);
  assert.equal(spent.state.fear, 10);
  assert.equal(spent.state.history.at(-1).type, 'spend_fear');
  const capped = resolveRoll(fearRoll.state, { difficulty: 10 }, fixedDice(2, 9));
  assert.equal(capped.result.fearGained, 0);
  assert.equal(capped.result.immediateComplication, true);
});

test('invalid or unaffordable calls do not roll dice or mutate state', () => {
  const state = initialState();
  let calls = 0;
  const die = () => { calls++; return 7; };
  assert.throws(() => resolveRoll(state, { difficulty: 0 }, die), { code: 'INVALID_DIFFICULTY' });
  assert.throws(() => resolveRoll({ ...state, hope: 1 }, {
    difficulty: 10,
    useHopeAdvantage: true,
  }, die), { code: 'INSUFFICIENT_HOPE' });
  assert.throws(() => resolveFearSpend(state), { code: 'INSUFFICIENT_FEAR' });
  assert.equal(calls, 0);
  assert.deepEqual(state, initialState());
});

test('CLI retains the complete history across processes and reset is explicit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narrative-dice-'));
  const statePath = join(directory, 'session.json');
  const cli = join(import.meta.dirname, 'cli.js');
  function call(command) {
    const run = spawnSync(process.execPath, [cli, '--state', statePath], {
      input: JSON.stringify(command),
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    return JSON.parse(run.stdout).result;
  }
  try {
    assert.deepEqual(call({ action: 'status' }), initialState());
    const engine = createEngine({ statePath, rollDie: fixedDice(2, 9) });
    const roll = await engine.roll({ difficulty: 10 });
    assert.equal(roll.outcome, 'success_fear');
    const after = call({ action: 'status' });
    assert.equal(after.fear, 1);
    assert.equal(after.history.length, 1);
    assert.equal(after.history[0].result.immediateComplication, true);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), after);
    assert.deepEqual(call({ action: 'reset' }), initialState());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
