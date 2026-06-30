import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicText } from '../persistence.js';
import type { Save, StoreBackend } from '../store.js';
import type { ExecutionEvent } from '../events.js';
import type { RecoveryReason } from '../recovery.js';

export interface Story { id: string; role: 'user' | 'assistant'; text: string; agent?: string }
export interface Journal {
  version: 2; phase: 'waiting' | 'running' | 'recovery'; sequence: number;
  events: ExecutionEvent[]; story: Story[];
  operations: Record<string, { status: 'running' | 'done' | 'failed' }>;
  pendingInput?: string; error?: string; recoveryReason?: RecoveryReason;
  stream?: { requestId: string; agent?: string; text: string };
}
export type WebSave = Save & { web: Journal };
type Checkpoint = Save & { web: Omit<Journal, 'events' | 'story' | 'stream'> };
type JournalRecord = { version: 2; kind: 'event'; event: ExecutionEvent; checkpoint?: Checkpoint }
  | { version: 2; kind: 'checkpoint'; checkpoint: Checkpoint };

export const freshJournal = (): Journal => ({ version: 2, phase: 'waiting', sequence: 0, events: [], story: [], operations: {} });

/** Player-facing history is reconstructed independently of compressed model context. */
export function projectEvent(web: Journal, event: ExecutionEvent): void {
  if (event.type === 'input.accepted') {
    web.story.push({ id: `${event.adventureId}:${event.id}`, role: 'user', text: event.text });
    delete web.pendingInput;
  }
  if (event.type === 'request.start' && event.purpose !== 'compression') web.stream = { requestId: event.requestId, agent: event.agent, text: '' };
  if (event.type === 'request.chunk' && event.purpose !== 'compression' && event.chunk.type === 'text' && web.stream?.requestId === event.requestId) web.stream.text += event.chunk.text;
  if (event.type === 'message.complete') {
    if (event.text) web.story.push({ id: event.requestId, role: 'assistant', text: event.text, agent: event.agent });
    delete web.stream;
  }
  if (event.type === 'request.error' && event.purpose !== 'compression') delete web.stream;
}

function checkpoint(data: Save): Checkpoint {
  const { events: _events, story: _story, stream: _stream, ...web } = (data as WebSave).web;
  return { ...data, web };
}

function assertCheckpoint(value: Checkpoint): void {
  if (!value || value.version !== 1 || !Array.isArray(value.main) || !Array.isArray(value.combat) || !value.memo ||
      value.web?.version !== 2 || !['waiting', 'running', 'recovery'].includes(value.web.phase) ||
      !Number.isSafeInteger(value.web.sequence) || value.web.sequence < 0 || !value.web.operations ||
      'events' in value.web || 'story' in value.web || 'stream' in value.web) throw new Error('网页检查点无效');
}

function assertEvent(event: ExecutionEvent, sequence: number): void {
  if (!event || !Number.isSafeInteger(event.id) || event.id <= sequence || typeof event.type !== 'string' || typeof event.adventureId !== 'string' ||
      event.type === 'input.accepted' && typeof event.text !== 'string' ||
      event.type === 'message.complete' && (typeof event.text !== 'string' || typeof event.requestId !== 'string') ||
      event.type === 'request.chunk' && (!event.chunk || typeof event.chunk.type !== 'string')) throw new Error('网页日志事件或序号无效');
}

export function validateWebSave(data: WebSave): void {
  assertCheckpoint(checkpoint(data));
  if (!Array.isArray(data.web.events) || !Array.isArray(data.web.story)) throw new Error('网页快照记录无效');
  let sequence = 0;
  for (const event of data.web.events) { assertEvent(event, sequence); sequence = event.id; }
  if (sequence > data.web.sequence) throw new Error('网页快照序号无效');
}

/** One line commits an event and its execution checkpoint together. Chunks carry no checkpoint. */
export class JournalBackend implements StoreBackend {
  constructor(readonly path: string) {}
  load(): WebSave | undefined {
    if (!existsSync(this.path)) return undefined;
    const bytes = readFileSync(this.path);
    const complete = bytes.lastIndexOf(10) + 1;
    const events: ExecutionEvent[] = [];
    let latest: Checkpoint | undefined;
    let sequence = 0;
    for (const line of bytes.subarray(0, complete).toString('utf8').split('\n').filter(Boolean)) {
      let record: JournalRecord;
      try { record = JSON.parse(line); } catch { throw new Error('网页日志中间记录损坏'); }
      if (record?.version !== 2 || !['event', 'checkpoint'].includes(record.kind)) throw new Error('网页日志格式无效；仅支持版本 2');
      if (record.kind === 'event') {
        const event = record.event;
        assertEvent(event, sequence);
        sequence = event.id; events.push(event);
      }
      if (record.checkpoint) {
        assertCheckpoint(record.checkpoint);
        if (record.checkpoint.web.sequence < sequence) throw new Error('网页检查点序号无效');
        sequence = record.checkpoint.web.sequence; latest = record.checkpoint;
      }
      else if (record.kind === 'checkpoint') throw new Error('网页日志缺少检查点');
    }
    if (!latest) throw new Error('网页日志缺少初始检查点');
    const web: Journal = { ...latest.web, sequence: Math.max(sequence, latest.web.sequence), events, story: [] };
    // Replay presentation only; execution comes exclusively from the last checkpoint.
    for (const event of events) projectEvent(web, event);
    web.pendingInput = latest.web.pendingInput;
    if (web.phase !== 'running') delete web.stream;
    if (complete !== bytes.length) truncateSync(this.path, complete);
    return { ...latest, web };
  }
  private append(record: JournalRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
  save(data: Save): void { this.append({ version: 2, kind: 'checkpoint', checkpoint: checkpoint(data) }); }
  event(event: ExecutionEvent, data: WebSave): void {
    this.append({ version: 2, kind: 'event', event, ...(event.type === 'request.chunk' ? {} : { checkpoint: checkpoint(data) }) });
  }
  install(data: WebSave): void {
    validateWebSave(data);
    const saved = checkpoint(data);
    const lines: JournalRecord[] = data.web.events.map(event => ({ version: 2, kind: 'event', event }));
    lines.push({ version: 2, kind: 'checkpoint', checkpoint: saved });
    atomicText(this.path, lines.map(line => JSON.stringify(line) + '\n').join(''));
  }
}
