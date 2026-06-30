import type { AdventureService, Event } from './service.js';

type State = ReturnType<AdventureService['state']>;
export type PublicStream = NonNullable<State['stream']>;
export interface StatePatch {
  values: Partial<Omit<State, 'story' | 'stream' | 'error'>> & { error?: string | null };
  storyAdded: State['story'];
  stream: null | { requestId: string; agent?: string; from: number; text: string };
}
export type EventPayload =
  | { version: 2; type: 'baseline'; history: true; state: State; events: Event[] }
  | { version: 2; type: 'delta'; history: false; after: number; events: Event[]; patch: StatePatch };

/** A splice also handles projections that retract trailing whitespace or hide JSON. */
export function streamPatch(before: PublicStream | undefined, after: PublicStream | undefined): StatePatch['stream'] {
  if (!after) return null;
  const prior = before?.requestId === after.requestId ? before.text : '';
  let from = 0;
  while (from < prior.length && from < after.text.length && prior[from] === after.text[from]) from++;
  return { requestId: after.requestId, agent: after.agent, from, text: after.text.slice(from) };
}
