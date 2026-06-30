import type { AdventureState, EventPayload } from './types.ts';

/** Reject gaps before applying a patch; a new baseline repairs any missed transport state. */
export function applyAdventureUpdate(state: AdventureState | null, cursor: number, payload: EventPayload) {
  if (payload.version !== 2) throw new Error('不支持的冒险传输版本');
  if (payload.type === 'baseline') return { state: payload.state, cursor: payload.state.sequence, events: payload.events, history: true };
  if (!state) throw new Error('缺少冒险基线');
  if (payload.events.length && payload.events.every(event => event.id <= cursor)) return { state, cursor, events: [], history: false };
  if (payload.after !== cursor || !payload.events.length || payload.events.some((event, index) => event.id !== cursor + index + 1) ||
      payload.patch.values.sequence !== payload.events.at(-1)!.id) throw new Error('冒险事件序号不连续');
  const { values, storyAdded, stream } = payload.patch;
  if (stream && (stream.from < 0 || stream.from > (state.stream?.requestId === stream.requestId ? state.stream.text.length : 0))) throw new Error('冒险流式更新位置无效');
  const next: AdventureState = { ...state, ...values, error: values.error === null ? undefined : values.error ?? state.error,
    story: [...state.story, ...storyAdded],
    stream: stream ? { requestId: stream.requestId, agent: stream.agent,
      text: (state.stream?.requestId === stream.requestId ? state.stream.text : '').slice(0, stream.from) + stream.text } : undefined };
  return { state: next, cursor: payload.events.at(-1)!.id, events: payload.events, history: false };
}
