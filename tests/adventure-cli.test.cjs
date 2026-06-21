const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, copyFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = resolve(__dirname, '..');
const cli = join(root, 'cli.js');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'witcher-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const state = join(directory, 'adventure.json');
  const run = (input, options = {}) => {
    const execution = spawnSync(process.execPath, [options.cli ?? cli, ...(options.args ?? ['--state', state])], {
      cwd: options.cwd ?? directory,
      env: { ...process.env, ADVENTURE_SESSION_FILE: '', ...options.env },
      input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8'
    });
    assert.equal(execution.stderr, '');
    assert.equal(execution.error, undefined);
    const output = JSON.parse(execution.stdout);
    assert.equal(execution.status, output.ok ? 0 : 1);
    return output;
  };
  const ok = (input, options) => {
    const output = run(input, options);
    assert.equal(output.ok, true, JSON.stringify(output));
    return output.result;
  };
  const rejects = (input, code) => {
    const before = existsSync(state) ? readFileSync(state, 'utf8') : null;
    const output = run(input);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, code, JSON.stringify(output));
    assert.equal(existsSync(state) ? readFileSync(state, 'utf8') : null, before);
  };
  return { directory, state, run, ok, rejects };
}

test('unified CLI continues narrative, both battle sides and narrative across processes and working directories', t => {
  const f = fixture(t);
  let state = f.ok({ action: 'status' }, { cwd: root });
  assert.deepEqual(state.resources, { hope: 2, fear: 0 });
  state = f.ok({ action: 'roll', expectedRevision: state.revision, difficulty: 12 });
  const before = state.resources;
  state = f.ok({ action: 'startBattle', expectedRevision: state.revision,
    config: { monsterId: 'wolf', seed: 42, initiative: 'monster', maxActions: 20 } }, { cwd: root });
  assert.deepEqual(state.resources, before);
  const battleId = state.battle.battleId;
  const actors = new Set();
  while (state.owner === 'combat') {
    const view = state.battle.view;
    const command = view.pending
      ? { type: 'decision', choice: view.pending.kind === 'dying' ? 'survive' : 'skip' }
      : { type: 'action', id: view.initiative === 'geralt' ? 'sword:normal' : 'attack:normal' };
    if (!view.pending) actors.add(view.initiative);
    state = f.ok({ action: 'act', battleId, expectedRevision: state.battle.revision, command });
    assert.deepEqual(state.resources, { hope: state.battle.view.hope, fear: state.battle.view.fear });
  }
  assert.deepEqual(actors, new Set(['monster', 'geralt']));
  const result = f.ok({ action: 'battleResult' });
  assert.equal(result.outcome, state.battle.view.outcome);
  assert.deepEqual(result.resources, state.resources);
  assert(result.events.length > 0);
  assert.equal(typeof result.combatants.geralt.dead, 'boolean');
  state = f.ok({ action: 'roll', expectedRevision: state.revision, difficulty: 12 });
  assert.deepEqual(f.ok({ action: 'battleResult', battleId }), result);
  state = f.ok({ action: 'startBattle', expectedRevision: state.revision, config: { monsterId: 'drowner' } });
  assert.notEqual(state.battle.battleId, battleId);
  assert.deepEqual(f.ok({ action: 'battleResult', battleId }), result);
  assert.deepEqual(f.ok({ action: 'status' }, { cwd: root }), state);
});

test('rejected commands preserve the ledger and terminal reads never settle an active battle', t => {
  const f = fixture(t);
  let state = f.ok({ action: 'reset' });
  f.rejects({ action: 'spendFear', expectedRevision: state.revision }, 'INSUFFICIENT_FEAR');
  f.rejects({ action: 'startBattle', expectedRevision: state.revision - 1, config: { monsterId: 'wolf' } }, 'STALE_REVISION');
  f.rejects({ action: 'startBattle', expectedRevision: state.revision, config: { monsterId: 'grave_hag' } }, 'INVALID_CONFIG');
  f.rejects({ action: 'startBattle', expectedRevision: state.revision, config: { monsterId: 'wolf', hope: 6 } }, 'INVALID_CONFIG');
  state = f.ok({ action: 'startBattle', expectedRevision: state.revision, config: { monsterId: 'wolf', seed: 42 } });
  for (const action of ['roll', 'spendFear', 'startBattle']) {
    f.rejects({ action, expectedRevision: state.revision, difficulty: 12, config: { monsterId: 'wolf' } }, 'WRONG_OWNER');
  }
  f.rejects({ action: 'battleResult' }, 'BATTLE_NOT_FINISHED');
  f.rejects({ action: 'battleResult', battleId: null }, 'INVALID_COMMAND');
  f.rejects({ action: 'battleResult', battleId: 'missing' }, 'BATTLE_NOT_FOUND');
  const act = { action: 'act', battleId: state.battle.battleId, expectedRevision: state.battle.revision };
  f.rejects({ ...act, expectedRevision: 99, command: { type: 'action', id: 'sword:normal' } }, 'STALE_REVISION');
  f.rejects({ ...act, command: { type: 'action', id: 'invented' } }, 'ILLEGAL_COMMAND');
  f.rejects({ ...act, command: { type: 'action', id: 'sword:normal', useHopeAdvantage: 'yes' } }, 'INVALID_COMMAND');
});

test('insufficient combat hope cannot commit', async t => {
  const f = fixture(t);
  const { createAdventureSession } = await import(pathToFileURL(join(root, 'CombatEngine/dist/src/adventure-session.js')));
  const adventure = createAdventureSession(f.state);
  // Deterministic narrative rolls arrange an empty hope pool through public rules.
  for (let i = 0; i < 2; i++) {
    const dice = [1, 12];
    const current = adventure.status();
    adventure.narrativeRoll(current.revision, { difficulty: 30, useHopeAdvantage: i === 0 }, () => dice.shift());
  }
  let state = f.ok({ action: 'startBattle', expectedRevision: adventure.status().revision,
    config: { monsterId: 'wolf', seed: 42 } });
  f.rejects({ action: 'act', battleId: state.battle.battleId, expectedRevision: 0,
    command: { type: 'action', id: 'sword:normal', useHopeAdvantage: true } }, 'ILLEGAL_COMMAND');
});
test('pending dying choice survives a CLI restart', t => {
  const f = fixture(t);
  const config = { monsterId: 'fiend', seed: 123456, initiative: 'monster', initial: { geralt: { hp: 1, armor: 0 } } };
  let state = f.ok({ action: 'reset' });
  state = f.ok({ action: 'startBattle', expectedRevision: state.revision, config });
  state = f.ok({ action: 'act', battleId: state.battle.battleId, expectedRevision: 0,
    command: { type: 'action', id: 'attack:normal' } });
  assert.equal(state.battle.view.pending.kind, 'dying');
  const { events, ...persisted } = state;
  assert(events.some(event => event.type === 'decision_required'));
  assert.deepEqual(f.ok({ action: 'status' }), persisted);
  state = f.ok({ action: 'act', battleId: state.battle.battleId, expectedRevision: state.battle.revision,
    command: { type: 'decision', choice: 'survive' } });
  assert.equal(state.owner, 'narrative');
  assert.equal(f.ok({ action: 'battleResult' }).outcome, 'geralt_incapacitated');
});

test('state path precedence and default are independent of working directory', t => {
  const f = fixture(t);
  const envPath = join(f.directory, 'env.json');
  const env = { ADVENTURE_SESSION_FILE: envPath };
  f.ok({ action: 'reset' }, { args: [], env });
  const envBefore = readFileSync(envPath, 'utf8');
  f.ok({ action: 'reset' }, { env });
  assert(existsSync(f.state));
  assert.equal(readFileSync(envPath, 'utf8'), envBefore);
  assert.deepEqual(f.ok({ action: 'status' }, { args: [], env }), f.ok({ action: 'status' }, { args: ['--state', envPath] }));
  // A read-only status must resolve the same default file from either directory.
  assert.deepEqual(f.ok({ action: 'status' }, { args: [], cwd: root }), f.ok({ action: 'status' }, { args: [] }));
  assert.equal(existsSync(join(f.directory, 'NarrativeDice')), false);
});

test('monster catalog returns readable machine-readable descriptions', t => {
  const f = fixture(t);
  const catalog = f.ok({ action: 'monsters' });
  assert.equal(catalog.monsters.length, 24);
  assert(catalog.monsters.every(monster => monster.id && monster.name && monster.description && !monster.description.includes('undefined')));
});
test('malformed requests return machine-readable errors without changing the ledger', t => {
  const f = fixture(t);
  for (const input of ['{', '', '[]', 'null', '4']) f.rejects(input, 'INVALID_COMMAND');
  f.rejects({ action: 'nope' }, 'UNKNOWN_ACTION');
});
test('invalid CLI arguments return a machine-readable error', t => {
  const f = fixture(t);
  assert.equal(f.run({ action: 'status' }, { args: ['--wrong'] }).error.code, 'INVALID_ARGUMENTS');
});
test('missing build returns a machine-readable recovery instruction', t => {
  const f = fixture(t);
  const isolatedCli = join(f.directory, 'cli.js');
  copyFileSync(cli, isolatedCli);
  const missing = f.run({ action: 'status' }, { cli: isolatedCli });
  assert.equal(missing.error.code, 'BUILD_REQUIRED');
  assert.match(missing.error.message, /npm run build/);
});

test('action limit remains a distinct terminal outcome', t => {
  const f = fixture(t);
  let state = f.ok({ action: 'startBattle', expectedRevision: 0,
    config: { monsterId: 'fiend', seed: 42, maxActions: 1 } });
  state = f.ok({ action: 'act', battleId: state.battle.battleId, expectedRevision: 0,
    command: { type: 'action', id: 'sign:quen' } });
  assert.equal(state.owner, 'narrative');
  assert.equal(f.ok({ action: 'battleResult' }).outcome, 'action_limit');
});
