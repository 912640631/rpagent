import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdventureSession } from '../src/adventure-session.js';

test('rule snapshots are detached, validate before writing and install idempotently with the same random continuation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'witcher-rule-snapshot-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'rules.json'); const session = createAdventureSession(path);
  session.initializeRandomState();
  const saved = session.exportSnapshot();
  const before = readFileSync(path);
  session.validateSnapshot(saved); assert.deepEqual(readFileSync(path), before);
  const detached = saved as { hope: number }; detached.hope = 99;
  assert.throws(() => session.installSnapshot(detached), /invalid/); assert.deepEqual(readFileSync(path), before);
  const good = session.exportSnapshot();
  const expected = session.narrativeRoll(session.status().revision, { difficulty: 12 });
  session.installSnapshot(good); const installed = readFileSync(path);
  session.installSnapshot(good); assert.deepEqual(readFileSync(path), installed);
  const replayed = session.narrativeRoll(session.status().revision, { difficulty: 12 });
  assert.deepEqual(replayed.result, expected.result); assert.deepEqual(replayed.resources, expected.resources);
});

test('a snapshot with an incompatible current or archived battle is rejected before replacing rules', t => {
  const directory = mkdtempSync(join(tmpdir(), 'witcher-snapshot-revision-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'rules.json'); const session = createAdventureSession(path);
  const start = session.startBattle(0, { monsterId: 'wolf', maxActions: 1, seed: 1, initiative: 'monster' });
  session.act(start.battle!.battleId, 0, { type: 'action', id: 'attack:normal' });
  const next = session.startBattle(session.status().revision, { monsterId: 'wolf', seed: 2 });
  const before = readFileSync(path);
  for (const archived of [false, true]) {
    const snapshot = session.exportSnapshot() as { battle: { state: { dataRevision: string } }; battleArchive: { state: { dataRevision: string } }[] };
    (archived ? snapshot.battleArchive[0]! : snapshot.battle).state.dataRevision = 'incompatible';
    assert.throws(() => session.installSnapshot(snapshot), /different combat data revision/);
    assert.deepEqual(readFileSync(path), before); assert.equal(session.status().battle!.battleId, next.battle!.battleId);
  }
});
