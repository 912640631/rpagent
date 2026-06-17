import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { initialState, resolveFearSpend, resolveRoll, type NarrativeState } from '@ai-gm/narrative-dice';
import { dataRevision } from './data.js';
import { advanceBattle, createBattle } from './engine.js';
import { makeSessionView } from './session-view.js';
import type { BattleConfig, BattleState, Command } from './types.js';

interface StoredBattle {
  battleId: string;
  revision: number;
  state: BattleState;
}

interface AdventureState extends NarrativeState {
  revision: number;
  owner: 'narrative' | 'combat';
  battle: StoredBattle | null;
}

export class AdventureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function defaultAdventurePath(): string {
  return resolve('NarrativeDice/.local/adventure.json');
}

function fresh(): AdventureState {
  return { ...initialState(), revision: 0, owner: 'narrative', battle: null };
}

function read(path: string): AdventureState {
  if (!existsSync(path)) return fresh();
  let state: AdventureState;
  try { state = JSON.parse(readFileSync(path, 'utf8')) as AdventureState; }
  catch { throw new AdventureError('CORRUPT_SESSION', 'Adventure state is not valid JSON'); }
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.hope) || state.hope < 0 || state.hope > 6 ||
      !Number.isSafeInteger(state.fear) || state.fear < 0 || state.fear > 12 ||
      !Array.isArray(state.history) || !['narrative', 'combat'].includes(state.owner) ||
      (state.battle !== null && (!state.battle || typeof state.battle.battleId !== 'string' ||
        !Number.isSafeInteger(state.battle.revision) || !state.battle.state ||
        state.battle.state.hope !== state.hope || state.battle.state.fear !== state.fear)) ||
      (state.owner === 'combat' && (!state.battle || state.battle.state.outcome)) ||
      (state.owner === 'narrative' && state.battle !== null && !state.battle.state.outcome)) {
    throw new AdventureError('CORRUPT_SESSION', 'Adventure state or resource ledger is invalid');
  }
  if (state.battle && state.battle.state.dataRevision !== dataRevision) {
    throw new AdventureError('DATA_MISMATCH', 'Stored battle uses a different combat data revision');
  }
  return state;
}

function write(path: string, state: AdventureState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function locked<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { mkdirSync(lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
      } catch (staleError) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((staleError as NodeJS.ErrnoException).code ?? '')) throw staleError;
      }
      Atomics.wait(pause, 0, 0, 25);
    }
  }
  if (!acquired) throw new AdventureError('SESSION_BUSY', 'Adventure state is busy');
  try { return operation(); }
  finally { rmdirSync(lock); }
}

function checkRevision(state: AdventureState, expectedRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new AdventureError('INVALID_REVISION', 'Expected revision must be a nonnegative integer');
  }
  if (state.revision !== expectedRevision) throw new AdventureError('STALE_REVISION', 'Adventure revision has changed');
}

function checkOwner(state: AdventureState, owner: AdventureState['owner']): void {
  if (state.owner !== owner) throw new AdventureError('WRONG_OWNER', `Resource ledger belongs to ${state.owner}`);
}

function view(state: AdventureState) {
  return {
    revision: state.revision, owner: state.owner,
    resources: { hope: state.hope, fear: state.fear },
    history: structuredClone(state.history),
    battle: state.battle ? {
      battleId: state.battle.battleId, revision: state.battle.revision,
      view: makeSessionView(state.battle.state)
    } : null
  };
}

export function createAdventureSession(storagePath = defaultAdventurePath()) {
  const path = resolve(storagePath);
  return {
    status() { return view(read(path)); },
    reset() {
      return locked(path, () => {
        const state = fresh();
        write(path, state);
        return view(state);
      });
    },
    narrativeRoll(expectedRevision: number, input: { difficulty: number; modifier?: number; useHopeAdvantage?: boolean }, rollDie?: () => number) {
      return locked(path, () => {
        const state = read(path);
        checkRevision(state, expectedRevision);
        checkOwner(state, 'narrative');
        const { state: rolled, result } = resolveRoll(state, input, rollDie);
        const next = { ...state, ...rolled, revision: state.revision + 1 };
        if (next.battle) {
          next.battle.state.hope = next.hope;
          next.battle.state.fear = next.fear;
        }
        write(path, next);
        return { ...view(next), result };
      });
    },
    spendFear(expectedRevision: number) {
      return locked(path, () => {
        const state = read(path);
        checkRevision(state, expectedRevision);
        checkOwner(state, 'narrative');
        const { state: spent, result } = resolveFearSpend(state);
        const next = { ...state, ...spent, revision: state.revision + 1 };
        if (next.battle) next.battle.state.fear = next.fear;
        write(path, next);
        return { ...view(next), result };
      });
    },
    startBattle(expectedRevision: number, config: BattleConfig) {
      return locked(path, () => {
        const state = read(path);
        checkRevision(state, expectedRevision);
        checkOwner(state, 'narrative');
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw new AdventureError('INVALID_CONFIG', 'Battle config must be an object');
        }
        if (config.hope !== undefined || config.fear !== undefined) {
          throw new AdventureError('INVALID_CONFIG', 'Battle resources come from the adventure ledger');
        }
        let battle: BattleState;
        try { battle = createBattle({ ...config, hope: state.hope, fear: state.fear,
          seed: config.seed ?? randomInt(1, 0x7fffffff) }); }
        catch (error) { throw new AdventureError('INVALID_CONFIG', (error as Error).message); }
        const battleId = randomUUID();
        const next: AdventureState = { ...state, revision: state.revision + 1, owner: 'combat',
          battle: { battleId, revision: 0, state: battle },
          history: [...state.history, { id: state.history.length + 1, type: 'battle_started',
            at: new Date().toISOString(), result: { battleId, monsterId: config.monsterId } }] };
        write(path, next);
        return view(next);
      });
    },
    act(battleId: string, expectedRevision: number, command: Command) {
      return locked(path, () => {
        const state = read(path);
        checkOwner(state, 'combat');
        const current = state.battle!;
        if (current.battleId !== battleId) throw new AdventureError('BATTLE_NOT_FOUND', 'Battle ID is not active');
        if (!Number.isSafeInteger(expectedRevision) || current.revision !== expectedRevision) {
          throw new AdventureError('STALE_REVISION', 'Battle revision has changed');
        }
        let battle: BattleState;
        try { battle = advanceBattle(current.state, command); }
        catch (error) { throw new AdventureError('ILLEGAL_COMMAND', (error as Error).message); }
        const events = battle.events.slice(current.state.events.length);
        const next: AdventureState = {
          ...state, revision: state.revision + 1,
          owner: battle.outcome ? 'narrative' : 'combat', hope: battle.hope, fear: battle.fear,
          battle: { battleId, revision: current.revision + 1, state: battle },
          history: [...state.history, { id: state.history.length + 1, type: 'battle_action',
            at: new Date().toISOString(), result: { battleId, command, events,
              outcome: battle.outcome, resources: { hope: battle.hope, fear: battle.fear } } }]
        };
        write(path, next);
        return { ...view(next), events };
      });
    }
  };
}
