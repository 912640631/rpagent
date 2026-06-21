import type { AgentRole } from './store.js';
import type { Rules } from './tools.js';
import type { StreamChunk, ToolCall } from './types.js';

type Request = { agent: AgentRole; requestId: string; model: string; purpose?: 'compression' };
export type ToolResult = ReturnType<Rules['execute']> | { error: string } | {
  recovered: true; ruleStepAlreadyCommitted: true;
  status: ReturnType<Rules['status']>;
  battle: ReturnType<Rules['adventure']['status']>['battle'];
  result?: unknown;
};

/** Public producer/consumer contract. The event type determines its payload. */
export type HarnessEvent =
  | (Request & { type: 'request.start'; prompt: string; settingsRevision?: number; reasoning?: string | null })
  | (Request & { type: 'request.chunk'; chunk: StreamChunk })
  | (Request & { type: 'request.end'; elapsedMs: number; usage?: number })
  | (Request & { type: 'request.error'; elapsedMs: number })
  | { type: 'input.accepted'; text: string }
  | { type: 'message.complete'; agent: AgentRole; requestId: string; text: string }
  | { type: 'tool.start'; agent: AgentRole; requestId?: string; call: ToolCall }
  | { type: 'tool.result'; agent: AgentRole; requestId?: string; call: ToolCall; result: ToolResult }
  | { type: 'battle.handoff'; agent: 'combat'; requestId?: string; battleId: string; test?: boolean };

export type ExecutionEvent = (HarnessEvent
  | { type: 'notice'; text: string }
  | { type: 'queue.changed'; queued: number }
  | { type: 'operation.start' | 'operation.end'; operationId: string }
  | { type: 'operation.error'; operationId: string; message: string }
  | { type: 'snapshot.saved'; snapshotId: string; name: string; createdAt: string }
  | { type: 'snapshot.restored'; snapshotId: string; backupId: string }
) & { id: number; adventureId: string; time: string };

// Presentation only needs the recorded tool result, including small fixture events.
export type DiceEvent = { id: number; type: string; call?: Pick<ToolCall, 'name'>; result?: unknown };
