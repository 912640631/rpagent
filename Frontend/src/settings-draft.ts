import type { Settings, WebProvider, WebRoute } from '../../RpgAgent/src/web/settings.js';
import type { AgentRole, SettingsResponse } from './types.ts';
export type BudgetKey = 'maxOutputTokens' | 'recentTokens' | 'battleResultTokens' | 'compressionThreshold';
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? '';

export function parseProviders(text: string): Record<string, WebProvider> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) throw new Error('Provider JSON 必须是包含至少一个连接的对象');
  for (const [id, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Provider ${id} 必须是对象`);
    const p = item as Record<string, unknown>;
    if (p.protocol !== 'openai-chat' || typeof p.baseURL !== 'string' || typeof p.defaultModel !== 'string' || !p.defaultModel.trim() || !Number.isSafeInteger(p.contextTokens) || Number(p.contextTokens) < 4096) throw new Error(`Provider ${id} 需要 openai-chat 协议、API 地址、默认模型和至少 4096 的上下文容量`);
    for (const key of ['apiKey', 'apiKeyEnv']) if (p[key] !== undefined && typeof p[key] !== 'string') throw new Error(`Provider ${id} 的 ${key} 必须是字符串`);
    if (p.reasoning !== undefined) {
      const r = p.reasoning as Record<string, unknown> | null;
      if (!r || typeof r !== 'object' || Array.isArray(r) || !['reasoning_effort', 'thinking'].includes(String(r.field)) || !r.values || typeof r.values !== 'object' || Array.isArray(r.values)) throw new Error(`Provider ${id} 的推理能力格式无效`);
    }
  }
  return value as Record<string, WebProvider>;
}
export interface SettingsDraftState {
  saved: SettingsResponse | null; draft: Settings | null; json: string; jsonDirty: boolean; jsonError: string; revision: number;
}
export const emptySettingsDraft: SettingsDraftState = { saved: null, draft: null, json: '', jsonDirty: false, jsonError: '', revision: 0 };
export type DraftAction =
  | { type: 'loaded'; response: SettingsResponse }
  | { type: 'saved'; response: SettingsResponse; submittedRevision: number }
  | { type: 'route'; role: AgentRole; patch: Partial<WebRoute> }
  | { type: 'budget'; key: BudgetKey; value: number }
  | { type: 'provider'; id: string; patch: Partial<WebProvider> }
  | { type: 'add-provider' }
  | { type: 'json'; text: string }
  | { type: 'apply-json' };
function fromResponse(state: SettingsDraftState, response: SettingsResponse): SettingsDraftState {
  return { ...state, saved: response, draft: structuredClone(response.value), json: pretty(response.value.providers), jsonDirty: false, jsonError: '' };
}
export function settingsDraftReducer(state: SettingsDraftState, action: DraftAction): SettingsDraftState {
  if (action.type === 'loaded') return fromResponse(state, action.response);
  if (action.type === 'saved') return state.revision === action.submittedRevision ? fromResponse(state, action.response) : { ...state, saved: action.response };
  if (action.type === 'json') {
    let error = ''; try { parseProviders(action.text); } catch (e) { error = e instanceof Error ? e.message : '无效 JSON'; }
    return { ...state, json: action.text, jsonDirty: true, jsonError: error, revision: state.revision + 1 };
  }
  if (!state.draft) return state;
  const draft = state.draft;
  let next: Settings;
  switch (action.type) {
    case 'route': next = { ...draft, [action.role]: { ...draft[action.role], ...action.patch } }; break;
    case 'budget': next = { ...draft, [action.key]: action.value }; break;
    case 'provider':
      if (state.jsonDirty) return state;
      next = { ...draft, providers: { ...draft.providers, [action.id]: { ...draft.providers[action.id]!, ...action.patch } } }; break;
    case 'add-provider': {
      if (state.jsonDirty || !state.saved) return state;
      let index = Object.keys(draft.providers).length + 1;
      while (Object.hasOwn(draft.providers, `provider-${index}`)) index++;
      next = { ...draft, providers: { ...draft.providers, [`provider-${index}`]: structuredClone(state.saved.defaults.providers.local!) } }; break;
    }
    case 'apply-json':
      try { next = { ...draft, providers: parseProviders(state.json) }; }
      catch (e) { return { ...state, jsonError: e instanceof Error ? e.message : '无效 JSON' }; }
      break;
  }
  const providersChanged = next.providers !== draft.providers;
  return { ...state, draft: next, revision: state.revision + 1,
    ...(providersChanged ? { json: pretty(next.providers), jsonDirty: false, jsonError: '' } : {}) };
}
export function connectionChanged(state: SettingsDraftState, id: string): boolean {
  const current = state.draft?.providers[id], saved = state.saved?.value.providers[id];
  // Match every Provider field that can affect the saved catalogue request, excluding UI defaults.
  const connection = (p: WebProvider) => { const { defaultModel: _model, contextTokens: _capacity, reasoning: _reasoning, ...rest } = p; return rest; };
  return !current || !saved || pretty(connection(current)) !== pretty(connection(saved));
}
export function settingsPayload(state: SettingsDraftState): Settings {
  if (!state.draft) throw new Error('设置尚未读取');
  if (state.jsonError) throw new Error(`Provider JSON 无效：${state.jsonError}`);
  if (state.jsonDirty) throw new Error('请先应用 Provider JSON 再保存');
  return structuredClone(state.draft);
}
