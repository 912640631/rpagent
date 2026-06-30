import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson as write, withFileLock } from './persistence.js';
import { resolve } from 'node:path';
import { initialState, resolveFearSpend, resolveRoll, type NarrativeState } from '@ai-gm/narrative-dice';
import { validCommand } from './command.js';
import { dataRevision } from './data.js';
import { advanceBattle, createBattle } from './engine.js';
import { makeSessionView } from './session-view.js';
import type { BattleConfig, BattleState, Command } from './types.js';
import { nextRandom } from './dice.js';

export interface StoredBattle {
  battleId: string;
  revision: number;
  state: BattleState;
  metadata?: Record<string, unknown>;
  initialState?: BattleState;
  childSessionId?: string;
}

interface AdventureState extends NarrativeState {
  // Optional in existing version-1 ledgers; initialized before a full snapshot.
  randomState?: number;
  revision: number;
  owner: 'narrative' | 'combat';
  battle: StoredBattle | null;
  battleArchive?: StoredBattle[];
}

export class AdventureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function defaultAdventurePath(): string {
  return resolve('NarrativeDice/.local/adventure.json');
}

function fresh(revision = 0): AdventureState {
  return { ...initialState(), revision, owner: 'narrative', battle: null };
}

function validateState(value: unknown, checkDataRevision = true): AdventureState {
  const state = value as AdventureState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new AdventureError('CORRUPT_SESSION', 'Adventure state is invalid');
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Number.isSafeInteger(state.hope) || state.hope < 0 || state.hope > 6 ||
      !Number.isSafeInteger(state.fear) || state.fear < 0 || state.fear > 12 ||
      !Array.isArray(state.history) || !['narrative', 'combat'].includes(state.owner) ||
      (state.battle !== null && (!state.battle || typeof state.battle.battleId !== 'string' ||
        !Number.isSafeInteger(state.battle.revision) || !state.battle.state ||
        (state.owner === 'combat' && (state.battle.state.hope !== state.hope || state.battle.state.fear !== state.fear)))) ||
      (state.owner === 'combat' && (!state.battle || state.battle.state.outcome)) ||
      (state.owner === 'narrative' && state.battle !== null && !state.battle.state.outcome)) {
    throw new AdventureError('CORRUPT_SESSION', 'Adventure state or resource ledger is invalid');
  }
  if (state.battleArchive !== undefined && (!Array.isArray(state.battleArchive) ||
      state.battleArchive.some(record => !record || typeof record.battleId !== 'string' ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 || !record.state?.outcome))) {
    throw new AdventureError('CORRUPT_SESSION', 'Battle archive is invalid');
  }
  if (state.randomState !== undefined && (!Number.isSafeInteger(state.randomState) || state.randomState < 1 || state.randomState > 0xffffffff)) {
    throw new AdventureError('CORRUPT_SESSION', 'Adventure random state is invalid');
  }
  if (checkDataRevision && [state.battle, ...(state.battleArchive ?? [])].some(record => record && (record.state.version !== 1 || record.state.dataRevision !== dataRevision || record.initialState && record.initialState.dataRevision !== dataRevision))) {
    throw new AdventureError('DATA_MISMATCH', 'Stored battle uses a different combat data revision');
  }
  return state;
}

function read(path: string, checkDataRevision = true): AdventureState {
  if (!existsSync(path)) return fresh();
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new AdventureError('CORRUPT_SESSION', 'Adventure state is not valid JSON'); }
  return validateState(value, checkDataRevision);
}

function locked<T>(path: string, operation: () => T): T {
  return withFileLock(path, operation, () => new AdventureError('SESSION_BUSY', 'Adventure state is busy'));
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
    exportSnapshot(): unknown { return structuredClone(read(path)); },
    validateSnapshot(value: unknown): void { validateState(value); },
    installSnapshot(value: unknown): void {
      const state = structuredClone(validateState(value));
      locked(path, () => write(path, state));
    },
    /** Persist the random origin even when saving before the first rule action. */
    initializeRandomState() {
      return locked(path, () => {
        const state = read(path);
        if (state.randomState === undefined) {
          state.randomState = randomInt(1, 0x100000000);
          write(path, state);
        }
      });
    },
    /** Read-only engine snapshot, including completed battles from earlier handoffs. */
    battleRecord(battleId?: string): StoredBattle {
      const state = read(path);
      const record = battleId === undefined || state.battle?.battleId === battleId
        ? state.battle : state.battleArchive?.find(entry => entry.battleId === battleId);
      if (!record) throw new AdventureError('BATTLE_NOT_FOUND', 'Battle does not exist');
      if (record.state.dataRevision !== dataRevision) {
        throw new AdventureError('DATA_MISMATCH', 'Stored battle uses a different combat data revision');
      }
      return structuredClone(record);
    },
    /** Bind once; retries with the same child are idempotent and do not advance combat. */
    bindBattleChild(battleId: string, childSessionId: string): StoredBattle {
      return locked(path, () => {
        const state = read(path);
        const record = state.battle?.battleId === battleId ? state.battle
          : state.battleArchive?.find(entry => entry.battleId === battleId);
        if (!record) throw new AdventureError('BATTLE_NOT_FOUND', 'Battle does not exist');
        if (typeof childSessionId !== 'string' || !childSessionId.trim()) {
          throw new AdventureError('INVALID_CHILD', 'Child session ID must be nonempty');
        }
        if (record.childSessionId && record.childSessionId !== childSessionId) {
          throw new AdventureError('CHILD_ALREADY_BOUND', 'Battle already has a different child session');
        }
        if (!record.childSessionId) {
          record.childSessionId = childSessionId;
          state.revision++;
          write(path, state);
        }
        return structuredClone(record);
      });
    },
    reset() {
      return locked(path, () => {
        const revision = read(path, false).revision + 1;
        if (!Number.isSafeInteger(revision)) throw new AdventureError('INVALID_REVISION', 'Adventure revision exhausted');
        const state = fresh(revision);
        write(path, state);
        return view(state);
      });
    },
    narrativeRoll(expectedRevision: number, input: { difficulty: number; modifier?: number; useHopeAdvantage?: boolean }, rollDie?: () => number) {
      return locked(path, () => {
        const state = read(path);
        checkRevision(state, expectedRevision);
        checkOwner(state, 'narrative');
        const random = { randomState: state.randomState ?? randomInt(1, 0x100000000) };
        const { state: rolled, result } = resolveRoll(state, input, rollDie ?? (() => 1 + Math.floor(nextRandom(random) * 12)));
        const next = { ...state, ...rolled, randomState: random.randomState, revision: state.revision + 1 };
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
        write(path, next);
        return { ...view(next), result };
      });
    },
    startBattle(expectedRevision: number, config: BattleConfig, metadata?: Record<string, unknown>) {
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
        const random = { randomState: state.randomState ?? randomInt(1, 0x100000000) };
        try { battle = createBattle({ ...config, hope: state.hope, fear: state.fear,
          seed: config.seed ?? (1 + Math.floor(nextRandom(random) * 0x7ffffffe)) }); }
        catch (error) { throw new AdventureError('INVALID_CONFIG', (error as Error).message); }
        const battleId = randomUUID();
        const next: AdventureState = { ...state, randomState: random.randomState, revision: state.revision + 1, owner: 'combat',
          battle: { battleId, revision: 0, state: battle,
            ...(metadata ? { metadata: structuredClone(metadata), initialState: structuredClone(battle) } : {}) },
          battleArchive: [...(state.battleArchive ?? []), ...(state.battle ? [state.battle] : [])],
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
        if (!validCommand(command)) throw new AdventureError('INVALID_COMMAND', 'Command shape is invalid');
        let battle: BattleState;
        try { battle = advanceBattle(current.state, command); }
        catch (error) { throw new AdventureError('ILLEGAL_COMMAND', (error as Error).message); }
        const events = battle.events.slice(current.state.events.length);
        const next: AdventureState = {
          ...state, revision: state.revision + 1,
          owner: battle.outcome ? 'narrative' : 'combat', hope: battle.hope, fear: battle.fear,
          battle: { ...current, revision: current.revision + 1, state: battle },
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
