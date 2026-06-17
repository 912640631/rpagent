import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAdventureSession } from '../src/adventure-session.js';
import { advanceBattle, createBattle } from '../src/engine.js';

test('all Geralt check bearings change resources on success or failure and respect caps', () => {
  const outcomes = new Set<string>();
  for (let seed = 1; seed < 2000 && outcomes.size < 5; seed++) {
    for (const defense of [1, 30]) {
      const state = createBattle({ monsterId: 'wolf', seed, hope: 2, fear: 0 });
      state.combatants.monster.defense = defense;
      const next = advanceBattle(state, { type: 'action', id: 'sword:normal' });
      const check = next.events.find(event => event.type === 'check')!;
      const dice = check.details.dice as { hope: number; fear: number };
      const outcome = check.details.critical ? 'critical' :
        `${check.details.success ? 'success' : 'failure'}_${dice.hope > dice.fear ? 'hope' : 'fear'}`;
      outcomes.add(outcome);
      assert.equal(next.hope, 2 + Number(dice.hope >= dice.fear));
      assert.equal(next.fear, Number(dice.fear > dice.hope));
      if (check.details.critical) assert.equal(check.details.success, true);
    }
  }
  assert.deepEqual(outcomes, new Set(['critical', 'success_hope', 'success_fear', 'failure_hope', 'failure_fear']));

  const capped = advanceBattle(createBattle({ monsterId: 'wolf', seed: 42, hope: 6, fear: 12 }),
    { type: 'action', id: 'sword:normal' });
  assert.equal(capped.hope, 6);
  assert.equal(capped.fear, 12);
});

test('hope bonus stacks with environmental advantage and insufficient hope leaves state intact', () => {
  const state = createBattle({ monsterId: 'wolf', seed: 42, hope: 2 });
  const plain = advanceBattle(state, { type: 'action', id: 'sword:normal', advantage: 'advantage' });
  const boosted = advanceBattle(state, { type: 'action', id: 'sword:normal', advantage: 'advantage', useHopeAdvantage: true });
  const plainCheck = plain.events.find(event => event.type === 'check')!;
  const boostedCheck = boosted.events.find(event => event.type === 'check')!;
  assert.deepEqual(boostedCheck.details.dice, plainCheck.details.dice);
  assert.equal(boostedCheck.details.modifier, Number(plainCheck.details.modifier) + 3);
  assert(boosted.events.some(event => event.type === 'hope_spent' && event.details.amount === 2));
  assert.throws(() => advanceBattle(createBattle({ monsterId: 'wolf', seed: 42, hope: 1 }),
    { type: 'action', id: 'sword:normal', useHopeAdvantage: true }), /Insufficient hope/);
});

test('one persisted ledger spans narrative, battle and narrative across process boundaries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adventure-session-test-'));
  const path = join(directory, 'adventure.json');
  const session = createAdventureSession(path);
  const env = { ...process.env, ADVENTURE_SESSION_FILE: path };
  const run = (operation: string, input?: unknown) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', operation], {
      cwd: new URL('../', import.meta.url), env,
      input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8'
    });
    return { status: result.status, output: JSON.parse(result.stdout) as {
      ok: boolean; result: ReturnType<typeof session.status> & { events?: unknown[] }; error?: { code: string }
    } };
  };
  try {
    assert.deepEqual(session.status().resources, { hope: 2, fear: 0 });
    const first = session.narrativeRoll(0, { difficulty: 10 }, (() => {
      const values = [9, 2]; return () => values.shift()!;
    })());
    assert.deepEqual(first.resources, { hope: 3, fear: 0 });
    const started = run('adventure-start-battle', { expectedRevision: first.revision,
      config: { monsterId: 'wolf', seed: 42, initial: { monster: { hp: 1 } } } });
    assert.equal(started.status, 0);
    assert.equal(started.output.result.battle?.view.hope, 3);
    const battleId = started.output.result.battle!.battleId;
    const acted = run('adventure-act', { battleId, expectedRevision: 0,
      command: { type: 'action', id: 'sword:normal', part: 'torso', useHopeAdvantage: true } });
    assert.equal(acted.status, 0);
    assert.equal(acted.output.result.owner, 'narrative');
    assert.equal(acted.output.result.battle?.view.outcome, 'geralt_won');
    assert.equal(acted.output.result.battle?.view.hope, acted.output.result.resources.hope);
    assert.equal(acted.output.result.battle?.view.fear, acted.output.result.resources.fear);
    const repeated = run('adventure-act', { battleId, expectedRevision: 0,
      command: { type: 'action', id: 'sword:normal', useHopeAdvantage: true } });
    assert.equal(repeated.status, 1);
    assert.equal(repeated.output.error?.code, 'WRONG_OWNER');
    const afterBattle = session.status();
    assert.equal(afterBattle.history.filter(event => event.type === 'battle_action').length, 1);
    const final = session.narrativeRoll(afterBattle.revision, { difficulty: 20 }, (() => {
      const values = [1, 12]; return () => values.shift()!;
    })());
    assert.equal(final.resources.fear, Math.min(12, afterBattle.resources.fear + 1));
    assert.equal(final.history.length, 4);
    assert.deepEqual(run('adventure-status').output.result.resources, final.resources);
    assert.throws(() => session.narrativeRoll(afterBattle.revision, { difficulty: 10 }),
      (error: { code: string }) => error.code === 'STALE_REVISION');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('monster move spends shared fear and an unaffordable Geralt action does not commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adventure-resource-test-'));
  const session = createAdventureSession(join(directory, 'adventure.json'));
  try {
    const gained = session.narrativeRoll(0, { difficulty: 30 }, (() => {
      const values = [1, 12]; return () => values.shift()!;
    })());
    assert.equal(gained.resources.fear, 1);
    const started = session.startBattle(gained.revision, { monsterId: 'wolf', seed: 42, initiative: 'monster' });
    assert(started.battle);
    const acted = session.act(started.battle.battleId, 0, { type: 'action', id: 'attack:hamstring' });
    assert.equal(acted.resources.fear, 0);
    assert(acted.events.some(event => event.type === 'fear_spent' && event.details.amount === 1));
    assert.equal(acted.battle?.view.fear, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }

  const otherDirectory = mkdtempSync(join(tmpdir(), 'adventure-hope-test-'));
  const other = createAdventureSession(join(otherDirectory, 'adventure.json'));
  try {
    const spent = other.narrativeRoll(0, { difficulty: 30, useHopeAdvantage: true }, (() => {
      const values = [1, 12]; return () => values.shift()!;
    })());
    assert.equal(spent.resources.hope, 0);
    const started = other.startBattle(spent.revision, { monsterId: 'wolf', seed: 42 });
    assert(started.battle);
    assert.throws(() => other.act(started.battle!.battleId, 0,
      { type: 'action', id: 'sword:normal', useHopeAdvantage: true }),
      (error: { code: string }) => error.code === 'ILLEGAL_COMMAND');
    assert.equal(other.status().battle?.revision, 0);
    assert.equal(other.status().resources.hope, 0);
  } finally { rmSync(otherDirectory, { recursive: true, force: true }); }
});

test('reset rejects a command carrying a revision from the previous adventure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adventure-reset-test-'));
  const session = createAdventureSession(join(directory, 'adventure.json'));
  try {
    const previousRevision = session.status().revision;
    session.narrativeRoll(previousRevision, { difficulty: 10 }, () => 6);
    const restarted = session.reset();
    assert(restarted.revision > previousRevision);
    assert.throws(() => session.startBattle(previousRevision, { monsterId: 'wolf', seed: 42 }),
      (error: { code: string }) => error.code === 'STALE_REVISION');
    assert.equal(session.status().battle, null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('narrative actions preserve the completed battle resource snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adventure-snapshot-test-'));
  const session = createAdventureSession(join(directory, 'adventure.json'));
  try {
    const started = session.startBattle(0, { monsterId: 'wolf', seed: 42, initial: { monster: { hp: 1 } } });
    assert(started.battle);
    const finished = session.act(started.battle.battleId, 0,
      { type: 'action', id: 'sword:normal', useHopeAdvantage: true });
    assert.equal(finished.battle?.view.outcome, 'geralt_won');
    const finalBattleResources = { hope: finished.battle!.view.hope, fear: finished.battle!.view.fear };
    const values = [1, 12];
    const later = session.narrativeRoll(finished.revision, { difficulty: 30 }, () => values.shift()!);
    assert.notDeepEqual(later.resources, finalBattleResources);
    assert.deepEqual({ hope: later.battle?.view.hope, fear: later.battle?.view.fear }, finalBattleResources);
    const battleRecord = later.history.filter(event => event.type === 'battle_action').at(-1)!;
    assert.deepEqual((battleRecord.result as { resources: unknown }).resources, finalBattleResources);
    const spent = session.spendFear(later.revision);
    assert.equal(spent.resources.fear, 0);
    assert.deepEqual({ hope: spent.battle?.view.hope, fear: spent.battle?.view.fear }, finalBattleResources);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('adventure battle rejects nonboolean hope spending without changing resources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'adventure-command-test-'));
  const session = createAdventureSession(join(directory, 'adventure.json'));
  try {
    const started = session.startBattle(0, { monsterId: 'wolf', seed: 42 });
    assert(started.battle);
    const command = { type: 'action', id: 'sword:normal', useHopeAdvantage: 'false' };
    assert.throws(() => session.act(started.battle!.battleId, 0, command as never),
      (error: { code: string }) => error.code === 'INVALID_COMMAND');
    assert.equal(session.status().battle?.revision, 0);
    assert.deepEqual(session.status().resources, { hope: 2, fear: 0 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
