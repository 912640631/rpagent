import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { atomicJson as writeStored, withFileLock as withLock } from './persistence.js';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataRevision } from './data.js';
import { validCommand } from './command.js';
import { advanceBattle, createBattle } from './engine.js';
import { makeSessionView, type SessionView } from './session-view.js';
import type { BattleConfig, BattleState, Command, Event } from './types.js';

interface StoredSession {
  battleId: string;
  revision: number;
  state: BattleState;
}

export interface SessionSuccess {
  ok: true;
  battleId: string;
  revision: number;
  seed: number;
  view: SessionView;
  events: Event[];
  replacedBattleId?: string;
}

export type SessionErrorCode =
  'INVALID_CONFIG' | 'INVALID_COMMAND' | 'ILLEGAL_COMMAND' | 'NO_ACTIVE_BATTLE' |
  'BATTLE_NOT_FOUND' | 'STALE_REVISION' | 'BATTLE_FINISHED' | 'DATA_MISMATCH' |
  'CORRUPT_SESSION' | 'SESSION_BUSY' | 'INTERNAL_ERROR';

export interface SessionFailure {
  ok: false;
  error: { code: SessionErrorCode; message: string };
  current?: SessionSuccess;
}

export type SessionResult = SessionSuccess | SessionFailure;

function success(record: StoredSession, events: Event[], replacedBattleId?: string): SessionSuccess {
  return {
    ok: true, battleId: record.battleId, revision: record.revision,
    seed: record.state.seed, view: makeSessionView(record.state), events,
    ...(replacedBattleId ? { replacedBattleId } : {})
  };
}

function failure(code: SessionErrorCode, message: string, record?: StoredSession): SessionFailure {
  return { ok: false, error: { code, message }, ...(record ? { current: success(record, []) } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name === 'witcher-combat-engine') return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('CombatEngine package root not found');
    directory = parent;
  }
}

export function defaultSessionPath(): string {
  const key = createHash('sha256').update(packageRoot().toLowerCase()).digest('hex').slice(0, 16);
  return join(tmpdir(), 'witcher-combat-engine', key, 'current.json');
}

function readStored(path: string): StoredSession | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('CORRUPT_SESSION'); }
  if (!isRecord(value) || typeof value.battleId !== 'string' ||
      !Number.isSafeInteger(value.revision) || !isRecord(value.state) ||
      !Array.isArray(value.state.events)) throw new Error('CORRUPT_SESSION');
  return value as unknown as StoredSession;
}

export interface CombatSession {
  start(config: BattleConfig): SessionResult;
  act(battleId: string, expectedRevision: number, command: Command): SessionResult;
  view(battleId: string, includeHistory?: boolean): SessionResult;
}

export function createCombatSession(storagePath = defaultSessionPath()): CombatSession {
  const path = resolve(storagePath);

  function current(): StoredSession | SessionFailure | null {
    try {
      const record = readStored(path);
      if (record && (record.state.version !== 1 || record.state.dataRevision !== dataRevision)) {
        return failure('DATA_MISMATCH', 'Stored battle uses a different engine or data revision');
      }
      return record;
    } catch (error) {
      if ((error as Error).message === 'CORRUPT_SESSION') return failure('CORRUPT_SESSION', 'Stored battle state is invalid');
      throw error;
    }
  }

  function checked(battleId: string): StoredSession | SessionFailure {
    const record = current();
    if (!record) return failure('NO_ACTIVE_BATTLE', 'No active battle');
    if ('ok' in record) return record;
    if (record.battleId !== battleId) return failure('BATTLE_NOT_FOUND', 'Battle ID is not active', record);
    return record;
  }

  return {
    start(config: BattleConfig): SessionResult {
      if (!isRecord(config) || typeof config.monsterId !== 'string') {
        return failure('INVALID_CONFIG', 'monsterId is required');
      }
      let state: BattleState;
      try { state = createBattle({ ...config, seed: config.seed ?? randomInt(1, 0x7fffffff) }); }
      catch (error) { return failure('INVALID_CONFIG', (error as Error).message); }
      try {
        return withLock(path, () => {
          let previous: StoredSession | null = null;
          try { previous = readStored(path); }
          catch { /* A new battle can replace an invalid old session. */ }
          const record: StoredSession = { battleId: randomUUID(), revision: 0, state };
          writeStored(path, record);
          return success(record, [], previous?.battleId);
        });
      } catch (error) {
        if ((error as Error).message === 'SESSION_BUSY') return failure('SESSION_BUSY', 'Battle state is busy');
        throw error;
      }
    },
    act(battleId: string, expectedRevision: number, command: Command): SessionResult {
      try {
        return withLock(path, () => {
          const record = checked(battleId);
          if ('ok' in record) return record;
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            return failure('INVALID_COMMAND', 'expectedRevision must be a nonnegative integer', record);
          }
          if (record.revision !== expectedRevision) {
            return failure('STALE_REVISION', 'Battle revision has changed', record);
          }
          if (record.state.outcome) return failure('BATTLE_FINISHED', 'Battle has ended', record);
          if (!validCommand(command)) return failure('INVALID_COMMAND', 'Command shape is invalid', record);
          let next: BattleState;
          try { next = advanceBattle(record.state, command); }
          catch (error) { return failure('ILLEGAL_COMMAND', (error as Error).message, record); }
          const events = next.events.slice(record.state.events.length);
          const updated: StoredSession = { ...record, revision: record.revision + 1, state: next };
          writeStored(path, updated);
          return success(updated, events);
        });
      } catch (error) {
        if ((error as Error).message === 'SESSION_BUSY') return failure('SESSION_BUSY', 'Battle state is busy');
        throw error;
      }
    },
    view(battleId: string, includeHistory = false): SessionResult {
      const record = checked(battleId);
      if ('ok' in record) return record;
      return success(record, includeHistory ? structuredClone(record.state.events) : []);
    }
  };
}
