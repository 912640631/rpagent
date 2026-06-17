import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { monsterIds } from '../src/data.js';
import { advanceBattle, createBattle } from '../src/engine.js';
import { createCombatSession, type SessionSuccess } from '../src/session.js';
import { makeSessionView } from '../src/session-view.js';
import type { BattleState } from '../src/types.js';

function tempSession() {
  const directory = mkdtempSync(join(tmpdir(), 'combat-session-test-'));
  const path = join(directory, 'current.json');
  return { path, cleanup: () => { unlinkSync(path); rmdirSync(directory); } };
}

test('session keeps state outside the view and returns only events from this action', () => {
  const temporary = tempSession();
  try {
    const session = createCombatSession(temporary.path);
    const started = session.start({ monsterId: 'wolf', seed: 42 });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.equal(started.revision, 0);
    assert.equal(started.seed, 42);
    assert.deepEqual(started.events, []);
    assert(!('randomState' in started.view));
    assert(!('events' in started.view));
    assert(started.view.options.some(option => option.id === 'sword:normal' && option.description.includes('伤害')));
    assert(started.view.targetParts.some(part => part.id === 'head' && part.name === '头部'));

    const fromAnotherProcess = createCombatSession(temporary.path);
    const acted = fromAnotherProcess.act(started.battleId, 0, {
      type: 'action', id: 'sword:normal', part: 'torso'
    });
    assert.equal(acted.ok, true);
    if (!acted.ok) return;
    assert.equal(acted.revision, 1);
    assert(acted.events.length > 0);
    assert.equal(acted.events[0]?.sequence, 1);
    assert.equal(acted.events[0]?.type, 'action_started');

    const current = session.view(started.battleId);
    assert.equal(current.ok, true);
    if (!current.ok) return;
    assert.equal(current.revision, 1);
    assert.deepEqual(current.events, []);
    const history = session.view(started.battleId, true);
    assert.equal(history.ok, true);
    if (history.ok) assert.deepEqual(history.events, acted.events);
  } finally { temporary.cleanup(); }
});

test('stale and illegal commands leave the battle unchanged; new start replaces it', () => {
  const temporary = tempSession();
  try {
    const session = createCombatSession(temporary.path);
    const first = session.start({ monsterId: 'wolf', seed: 42 }) as SessionSuccess;
    const command = { type: 'action' as const, id: 'sword:normal', part: 'torso' };
    const acted = session.act(first.battleId, 0, command) as SessionSuccess;
    assert.equal(acted.ok, true);
    const stale = session.act(first.battleId, 0, command);
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.error.code, 'STALE_REVISION');
      assert.equal(stale.current?.revision, 1);
    }
    const illegal = session.act(first.battleId, 1, { type: 'action', id: 'not:legal' });
    assert.equal(illegal.ok, false);
    if (!illegal.ok) {
      assert.equal(illegal.error.code, 'ILLEGAL_COMMAND');
      assert.equal(illegal.current?.revision, 1);
    }
    const current = session.view(first.battleId);
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.revision, 1);

    const second = session.start({ monsterId: 'water_hag', seed: 43 });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.replacedBattleId, first.battleId);
    assert.equal(second.revision, 0);
    const old = session.view(first.battleId);
    assert.equal(old.ok, false);
    if (!old.ok) {
      assert.equal(old.error.code, 'BATTLE_NOT_FOUND');
      assert.equal(old.current?.battleId, second.battleId);
    }
  } finally { temporary.cleanup(); }
});

test('session CLI continues a battle across separate Node processes', () => {
  const temporary = tempSession();
  const env = { ...process.env, COMBAT_SESSION_FILE: temporary.path };
  function run(args: string[], input?: unknown) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: new URL('../', import.meta.url), env,
      input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout) as SessionSuccess;
  }
  try {
    const started = run(['session-start', '--monster', 'wolf', '--seed', '42']);
    assert.equal(started.ok, true);
    const acted = run(['session-act'], {
      battleId: started.battleId, expectedRevision: started.revision,
      command: { type: 'action', id: 'sword:normal', part: 'torso' }
    });
    assert.equal(acted.ok, true);
    assert.equal(acted.revision, 1);
    assert(acted.events.length > 0);
    const viewed = run(['session-view', '--battle-id', started.battleId]);
    assert.equal(viewed.revision, 1);
    assert.deepEqual(viewed.events, []);
    const repeated = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'session-act'], {
      cwd: new URL('../', import.meta.url), env,
      input: JSON.stringify({
        battleId: started.battleId, expectedRevision: started.revision,
        command: { type: 'action', id: 'sword:normal', part: 'torso' }
      }), encoding: 'utf8'
    });
    assert.equal(repeated.status, 1);
    assert.equal(JSON.parse(repeated.stdout).error.code, 'STALE_REVISION');
  } finally { temporary.cleanup(); }
});

test('every monster action and pending choice has a readable interface description', () => {
  for (const monsterId of monsterIds) {
    const state = createBattle({ monsterId, initiative: 'monster', fear: 12 });
    for (const option of makeSessionView(state).options) {
      assert.notEqual(option.description, option.name, `${monsterId}/${option.id} lacks a description`);
    }
  }

  let pending: BattleState | undefined;
  for (let seed = 1; seed < 1000; seed++) {
    const state = createBattle('fiend', seed);
    state.combatants.monster.defense = -100;
    state.combatants.monster.hp = 8;
    const next = advanceBattle(state, { type: 'action', id: 'sword:normal' });
    if (next.pending?.kind === 'bonus_action') { pending = next; break; }
  }
  assert(pending);
  const view = makeSessionView(pending);
  assert(view.pending?.options.some(option => option.id === 'potion:thunderbolt' && option.name === '雷霆'));
  assert(view.pending?.options.every(option => option.description.length > 0));
});
