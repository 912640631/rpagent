import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicJson } from './persistence.js';
import type { Message, ToolCall } from './types.js';
import { emptyMemo, type Memo } from './context.js';

export type AgentRole = 'main' | 'combat';
export interface PendingTool {
  call: ToolCall; revision: number; playerAuthorized: boolean;
  // Optional for existing version-1 saves; recover resolves it from the calling assistant message.
  owner?: AgentRole;
}
export interface PlayerIntent { battleId: string; revision: number; text: string }
export interface Save {
  version: 1; main: Message[]; memo: Memo; combat: Message[]; battleId?: string;
  settledBattleId?: string; mainUsage?: number; combatUsage?: number;
  pending?: PendingTool; playerIntent?: PlayerIntent; streamWithoutUsage?: boolean;
}
export interface StoreBackend { load(): Save | undefined; save(data: Save): void }

export class Store {
  data: Save;
  constructor(readonly path: string, private readonly backend?: StoreBackend) {
    const saved = backend ? backend.load() : existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    this.data = saved === undefined ? { version: 1, main: [], memo: emptyMemo(), combat: [] } : saved;
    if (!this.data || this.data.version !== 1 || !Array.isArray(this.data.main) || !Array.isArray(this.data.combat) || !this.data.memo) {
      throw new Error('应用存档无效，未覆盖。');
    }
  }
  save(): void {
    if (this.backend) this.backend.save(this.data);
    else atomicJson(this.path, this.data);
  }
}

export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('存档锁无效，请检查运行中的进程。');
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') unlinkSync(path);
      else throw new Error('无法检查存档锁。');
    }
  }
  try { writeFileSync(path, String(process.pid), { flag: 'wx' }); }
  catch { throw new Error('此存档已由另一个 RPG 进程打开。'); }
  return () => { if (existsSync(path)) unlinkSync(path); };
}
