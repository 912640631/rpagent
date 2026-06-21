import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Harness } from '../harness.js';
import type { ExecutionEvent } from '../events.js';
import { Store, acquireLock, type Save } from '../store.js';
import { Rules } from '../tools.js';
import type { Adapter } from '../types.js';
import { SettingsStore } from './settings.js';
import { atomicJson } from '../persistence.js';
import { visibleStoryText } from './story-text.js';

type Phase = 'waiting' | 'running' | 'recovery';
export interface Story { id: string; role: 'user' | 'assistant'; text: string; agent?: string }
export type Event = ExecutionEvent;
type WithoutPosition<T> = T extends unknown ? Omit<T, 'id' | 'adventureId' | 'time'> : never;
type EventData = WithoutPosition<Event>;
interface Journal {
  version: 1; phase: Phase; sequence: number; events: Event[]; story: Story[];
  operations: Record<string, { status: 'running' | 'done' | 'failed' }>;
  pendingInput?: string; error?: string; stream?: { requestId: string; agent?: string; text: string };
}
interface Snapshot { version: 1; kind?: 'manual' | 'restore-backup'; id: string; name: string; createdAt: string; session: Save & { web: Journal }; rules: unknown; settings: unknown }
interface Adventure { id: string; name: string; createdAt: string; test?: boolean }
interface Live {
  meta: Adventure; store: Store; rules: Rules; harness: Harness; release: () => void;
  tail: Promise<unknown>; queued: number;
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const validId = (id: string) => { if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('标识无效'); return id; };
const fresh = (): Journal => ({ version: 1, phase: 'waiting', sequence: 0, events: [], story: [], operations: {} });
const journal = (live: Live) => (live.store.data as Save & { web: Journal }).web;
function validateSnapshot(snapshot: Snapshot) {
  const phase = snapshot.session?.web?.phase;
  if (snapshot.version !== 1 || !snapshot.session?.web ||
      !(phase === 'waiting' || snapshot.kind === 'restore-backup' && phase === 'recovery')) {
    throw new Error('快照格式或安全节点无效');
  }
}

/** Owns every writer for web adventures; browser disconnects never own operation lifetimes. */
export class AdventureService {
  readonly settings: SettingsStore;
  private live = new Map<string, Live>();
  private listeners = new Set<(id: string, event: Event) => void>();
  private active?: string;
  private releaseRoot: () => void;
  private closed = false;
  constructor(readonly root: string, private readonly adapters?: { main: Adapter; combat: Adapter }) {
    mkdirSync(root, { recursive: true });
    this.releaseRoot = acquireLock(join(root, 'process.lock'));
    try {
      this.settings = new SettingsStore(join(root, 'settings.json'));
      if (existsSync(join(root, 'selection.json'))) this.active = read(join(root, 'selection.json')).id;
    } catch (error) { this.releaseRoot(); throw error; }
  }
  private directory(id: string) { return join(this.root, 'adventures', validId(id)); }
  list() {
    const dir = join(this.root, 'adventures');
    return { active: this.active, adventures: existsSync(dir) ? readdirSync(dir).filter(id => existsSync(join(dir, id, 'meta.json'))).map(id => read(join(dir, id, 'meta.json')) as Adventure).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [] };
  }
  create(name: string, test = false) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('冒险名称需为 1–100 字');
    const meta: Adventure = { id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString(), ...(test ? { test: true } : {}) };
    const dir = this.directory(meta.id);
    const store = new Store(join(dir, 'session.json'));
    Object.assign(store.data, { web: fresh() }); store.save();
    atomicJson(join(dir, 'meta.json'), meta);
    if (!this.active) this.selectNow(meta.id);
    return meta;
  }
  private selectNow(id: string) { this.active = id; atomicJson(join(this.root, 'selection.json'), { id }); }
  async select(id: string) {
    this.open(id);
    // Capture the source before waiting; no running request is re-routed to another adventure.
    if (this.active) await this.enqueue(this.open(this.active), async () => {});
    this.selectNow(id); return this.state(id);
  }
  private open(id: string): Live {
    const cached = this.live.get(id); if (cached) return cached;
    const dir = this.directory(id);
    if (!existsSync(join(dir, 'meta.json'))) throw new Error('冒险不存在');
    const release = acquireLock(join(dir, 'process.lock'));
    try {
      // Restore is a redo transaction. A crash between the two replacements is completed before opening.
      const restorePath = join(dir, 'restore.json');
      if (existsSync(restorePath)) { this.install(dir, read(restorePath)); unlinkSync(restorePath); }
      const store = new Store(join(dir, 'session.json'));
      const web = (store.data as Save & { web: Journal }).web;
      if (!web || web.version !== 1) throw new Error('这是旧存档；网页只支持新建的网页冒险');
      if (web.phase === 'running') { web.phase = 'recovery'; web.error = '上次执行被中断，请手动重试恢复。'; delete web.stream; store.save(); }
      const rules = new Rules(join(dir, 'rules.json'));
      const live = { meta: read(join(dir, 'meta.json')), store, rules, release, tail: Promise.resolve(), queued: 0 } as Live;
      this.bind(live); this.live.set(id, live); return live;
    } catch (error) { release(); throw error; }
  }
  private bind(live: Live) {
    const runtime = () => {
      const next = this.settings.runtime();
      return { ...next, adapters: this.adapters ?? next.adapters };
    };
    const start = runtime();
    live.harness = new Harness(start.config, live.store, live.rules, {
      text: () => {}, notice: text => this.emit(live, { type: 'notice', text }),
      event: event => {
        const web = journal(live);
        if (event.type === 'input.accepted') {
          web.story.push({ id: randomUUID(), role: 'user', text: String(event.text) }); delete web.pendingInput;
        }
        if (event.type === 'request.start' && event.purpose !== 'compression') web.stream = { requestId: event.requestId!, agent: event.agent, text: '' };
        if (event.type === 'request.chunk' && event.purpose !== 'compression' && event.chunk.type === 'text' && web.stream) web.stream.text += event.chunk.text;
        if (event.type === 'message.complete') {
          if (event.text) web.story.push({ id: event.requestId!, role: 'assistant', text: this.settings.sanitize(String(event.text)), agent: event.agent });
          delete web.stream;
        }
        if (event.type === 'request.error') delete web.stream;
        this.emit(live, { ...event, ...(event.type === 'request.start' ? { settingsRevision: this.settings.revision, reasoning: this.settings.value[event.agent!].reasoning ?? null } : {}) });
      },
    }, start.adapters, { beforeRequest: runtime, styles: () => ({ main: this.settings.value.main.style, combat: this.settings.value.combat.style }), compressionThreshold: () => this.settings.value.compressionThreshold });
  }
  private emit(live: Live, data: EventData) {
    const web = journal(live);
    const event: Event = this.settings.sanitize({ ...data, id: ++web.sequence, adventureId: live.meta.id, time: new Date().toISOString() });
    web.events.push(event); live.store.save();
    for (const listener of this.listeners) listener(live.meta.id, event);
    return event;
  }
  subscribe(listener: (id: string, event: Event) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private enqueue<T>(live: Live, action: () => Promise<T>): Promise<T> {
    live.queued++;
    const result = live.tail.then(async () => {
      try { return await action(); }
      finally { live.queued--; this.emit(live, { type: 'queue.changed', queued: live.queued }); }
    });
    live.tail = result.catch(() => {});
    return result;
  }
  state(id: string) {
    const live = this.open(id); const web = journal(live);
    const status = live.rules.adventure.status();
    return this.settings.sanitize({ ...live.meta, phase: web.phase, queued: live.queued, error: web.error, sequence: web.sequence,
      story: web.story.map(message => message.role === 'assistant' ? { ...message, text: visibleStoryText(message.text) } : message)
        .filter(message => message.role !== 'assistant' || message.text.trim().length > 0),
      stream: web.stream ? { ...web.stream, text: visibleStoryText(web.stream.text, true) } : undefined,
      rules: live.rules.status(), character: live.rules.latestCharacter(), battle: live.store.data.battleId ? live.rules.handoff.status(live.store.data.battleId).view : null,
      awaiting: live.store.data.battleId ? live.rules.handoff.status(live.store.data.battleId).awaiting : null,
      saves: this.snapshots(id), settingsRevision: this.settings.revision });
  }
  events(id: string, after = 0) { return this.settings.sanitize(journal(this.open(id)).events.filter(event => event.id > after)); }
  submit(id: string, operationId: string, input?: string, retry = false) {
    validId(operationId); const live = this.open(id); const web = journal(live);
    if (web.operations[operationId]) return { operationId, ...web.operations[operationId] };
    if (live.queued || web.phase === 'running') throw new Error('当前冒险正在处理，请等待');
    if (retry ? web.phase !== 'recovery' : web.phase !== 'waiting') throw new Error(retry ? '当前无需恢复' : '请先手动重试恢复');
    if (!retry && (typeof input !== 'string' || !input.trim() || input.length > 30000)) throw new Error('请输入 1–30000 字的行动');
    const previousError = web.error;
    web.operations[operationId] = { status: 'running' }; web.phase = 'running'; delete web.error;
    if (!retry) web.pendingInput = input!.trim();
    this.emit(live, { type: 'operation.start', operationId });
    void this.enqueue(live, async () => {
      try {
        if (retry && previousError?.includes('上下文')) {
          this.bind(live);
          await live.harness.recover();
          if (live.store.data.battleId) {
            live.harness.rebuildCombat();
            this.emit(live, { type: 'notice', text: '已从权威战斗状态重建本场上下文，保留尚未执行的玩家意图。' });
          } else await live.harness.compactMain();
        }
        await live.harness.turn(web.pendingInput);
        web.phase = 'waiting'; web.operations[operationId] = { status: 'done' };
        this.emit(live, { type: 'operation.end', operationId });
      } catch (error) {
        web.phase = 'recovery'; web.operations[operationId] = { status: 'failed' };
        web.error = this.settings.sanitize(error instanceof Error ? error.message : '执行失败');
        delete web.stream; this.emit(live, { type: 'operation.error', operationId, message: web.error });
      }
    });
    return { operationId, status: 'running' };
  }
  async idle(id: string) { await this.open(id).tail; return this.state(id); }
  private safe(live: Live) {
    if (journal(live).phase !== 'waiting' || live.store.data.pending) throw new Error('尚未到达安全节点；请先手动重试恢复');
    if (live.store.data.battleId && live.rules.handoff.status(live.store.data.battleId).awaiting === 'monster_action') throw new Error('仍需完成怪物行动');
  }
  snapshots(id: string) {
    const dir = join(this.directory(id), 'snapshots');
    return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json')).map(file => {
      const { id, name, createdAt, settings } = read(join(dir, file)) as Snapshot;
      return { id, name, createdAt, settings };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  }
  private snapshot(live: Live, name: string, kind: Snapshot['kind'] = 'manual') {
    live.rules.adventure.initializeRandomState();
    const id = randomUUID();
    const snapshot: Snapshot = { version: 1, kind, id, name, createdAt: new Date().toISOString(),
      session: this.settings.sanitize(structuredClone(live.store.data)) as Snapshot['session'],
      rules: existsSync(live.rules.path) ? read(live.rules.path) : null, settings: this.settings.public() };
    atomicJson(join(this.directory(live.meta.id), 'snapshots', `${id}.json`), snapshot);
    return { id, name, createdAt: snapshot.createdAt };
  }
  save(id: string, name: string) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('存档名称需为 1–100 字');
    const live = this.open(id);
    return this.enqueue(live, async () => { this.safe(live); const result = this.snapshot(live, name.trim()); this.emit(live, { type: 'snapshot.saved', ...result, snapshotId: result.id }); return result; });
  }
  private install(dir: string, snapshot: Snapshot) {
    validateSnapshot(snapshot);
    const rulePath = join(dir, 'rules.json');
    if (snapshot.rules === null) { if (existsSync(rulePath)) unlinkSync(rulePath); }
    else atomicJson(rulePath, snapshot.rules);
    atomicJson(join(dir, 'session.json'), snapshot.session);
  }
  restore(id: string, snapshotId: string) {
    const live = this.open(id); validId(snapshotId);
    return this.enqueue(live, async () => {
      // Failed operations are quiescent too. Back up their paired journal and rules
      // without replaying pending tools; restoring that backup still needs manual retry.
      if (journal(live).phase !== 'recovery') this.safe(live);
      const snapshot: Snapshot = read(join(this.directory(id), 'snapshots', `${snapshotId}.json`));
      validateSnapshot(snapshot);
      const backup = this.snapshot(live, `读取前备份 · ${new Date().toLocaleString('zh-CN')}`, 'restore-backup');
      // Keep the transport cursor monotonic even while story and rule time move backwards.
      snapshot.session.web.sequence = journal(live).sequence;
      snapshot.session.web.operations = { ...snapshot.session.web.operations, ...journal(live).operations };
      const transaction = join(this.directory(id), 'restore.json'); atomicJson(transaction, snapshot);
      this.install(this.directory(id), snapshot); unlinkSync(transaction);
      live.store.data = snapshot.session; this.bind(live);
      this.emit(live, { type: 'snapshot.restored', snapshotId, backupId: backup.id }); return this.state(id);
    });
  }
  testBattle(id: string, monsterId: string) {
    const source = this.open(id);
    return this.enqueue(source, async () => {
      this.safe(source);
      if (source.store.data.battleId) throw new Error('请从非战斗冒险创建独立测试');
      const monsters = source.rules.execute('list_monsters', {}) as { id: string }[];
      if (!monsters.some(m => m.id === monsterId)) throw new Error('怪物不在目录中');
      const meta = this.create(`战斗测试 · ${monsterId}`, true); const target = this.open(meta.id);
      if (existsSync(source.rules.path)) atomicJson(target.rules.path, read(source.rules.path));
      const result = target.rules.execute('start_battle', { monsterId, monsterObjectId: 'test-monster', scene: '独立战斗测试', facts: [], objectives: [], environment: [], risks: [] }) as { battleId: string };
      target.store.data.battleId = result.battleId;
      this.emit(target, { type: 'battle.handoff', agent: 'combat', battleId: result.battleId, test: true });
      return meta;
    });
  }
  monsters() { return new Rules(join(this.root, 'catalog-unused.json')).execute('list_monsters', {}); }
  async close() { if (this.closed) return; this.closed = true; await Promise.all([...this.live.values()].map(live => live.tail)); for (const live of this.live.values()) live.release(); this.releaseRoot(); }
}
