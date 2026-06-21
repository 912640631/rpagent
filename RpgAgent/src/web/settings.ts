import { existsSync, readFileSync } from 'node:fs';
import { atomicJson } from '../persistence.js';
import { ChatCompletionsAdapter } from '../adapter.js';
import { corePrompts } from '../harness.js';
import { providerModels } from './models.js';
import type { Adapter, AgentRoute, Config, Provider } from '../types.js';

import { defaultStyles } from './default-prompts.js';
export { defaultStyles } from './default-prompts.js';
export interface WebProvider extends Provider {
  reasoning?: { field: 'reasoning_effort' | 'thinking'; values: Record<string, unknown> };
}
export interface WebRoute extends AgentRoute { contextTokens: number; reasoning?: string; style: string }
export interface Settings extends Config {
  version: 1; providers: Record<string, WebProvider>; main: WebRoute; combat: WebRoute;
  compressionThreshold: number;
}
export const defaults: Settings = {
  version: 1, providers: { local: { protocol: 'openai-chat', baseURL: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model', contextTokens: 32768, stream: true } },
  main: { provider: 'local', contextTokens: 32768, style: defaultStyles.main },
  combat: { provider: 'local', contextTokens: 32768, style: defaultStyles.combat },
  maxOutputTokens: 2048, recentTokens: 6000, battleResultTokens: 1500, compressionThreshold: 0.75,
};
const reserved = new Set(['model', 'messages', 'tools', 'tool_choice', 'functions', 'function_call', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'temperature', 'top_p', 'reasoning_effort', 'thinking']);
function integer(value: unknown, min: number) { return Number.isSafeInteger(value) && Number(value) >= min; }
export function validateSettings(value: Settings): Settings {
  if (!value || value.version !== 1 || !value.providers || !Object.keys(value.providers).length) throw new Error('需要 version=1 和至少一个 Provider');
  for (const p of Object.values(value.providers)) {
    if (!p || p.protocol !== 'openai-chat' || typeof p.defaultModel !== 'string' || !p.defaultModel.trim()) throw new Error('Provider 需要默认模型和 openai-chat 协议');
    let url: URL; try { url = new URL(p.baseURL); } catch { throw new Error('API 地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址只支持无凭据和查询参数的 HTTP(S) 地址');
    if (!integer(p.contextTokens, 4096)) throw new Error('上下文容量至少为 4096');
    if (p.apiKey !== undefined && typeof p.apiKey !== 'string' || p.apiKeyEnv !== undefined && (typeof p.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.apiKeyEnv))) throw new Error('凭据来源格式无效');
    if (p.requestFields && (typeof p.requestFields !== 'object' || Array.isArray(p.requestFields) || Object.keys(p.requestFields).some(key => reserved.has(key) || /key|token|secret|password|authorization/i.test(key)))) throw new Error('额外字段不能覆盖协议、采样、推理或凭据字段');
    if (p.reasoning && (!['reasoning_effort', 'thinking'].includes(p.reasoning.field) || !p.reasoning.values || typeof p.reasoning.values !== 'object' || Array.isArray(p.reasoning.values))) throw new Error('推理能力需要字段名和服务支持的选项映射');
  }
  for (const field of ['maxOutputTokens', 'recentTokens', 'battleResultTokens'] as const) if (!integer(value[field], 1)) throw new Error(`${field} 必须为正整数`);
  if (!Number.isFinite(value.compressionThreshold) || value.compressionThreshold < 0.1 || value.compressionThreshold > 0.95) throw new Error('压缩比例应在 0.1 到 0.95 之间');
  for (const role of ['main', 'combat'] as const) {
    const route = value[role]; const p = value.providers[route?.provider];
    if (!p || !integer(route.contextTokens, 4096) || typeof route.style !== 'string' || route.style.length > 20000 || route.model !== undefined && typeof route.model !== 'string') throw new Error('Agent 的 Provider、模型、上下文或风格无效');
    route.model = route.model?.trim() || undefined;
    if (value.maxOutputTokens >= route.contextTokens / 2) throw new Error('输出上限必须小于 Agent 上下文容量的一半');
    if (route.reasoning && !Object.hasOwn(p.reasoning?.values ?? {}, route.reasoning)) throw new Error('所选 Provider 未声明此推理选项');
  }
  return structuredClone(value);
}
export class SettingsStore {
  value: Settings;
  revision = 0;
  constructor(readonly path: string) {
    this.value = validateSettings(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : structuredClone(defaults));
  }
  public() { return this.sanitize(this.value); }
  async models(id: string) {
    if (!Object.hasOwn(this.value.providers, id)) throw new Error('Provider 不存在');
    return this.sanitize(await providerModels(structuredClone(this.value.providers[id]!)));
  }
  sanitize<T>(value: T): T {
    const secrets = Object.values(this.value.providers).flatMap(p => [p.apiKey, p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined]).filter((s): s is string => Boolean(s));
    const walk = (v: any): any => {
      if (typeof v === 'string') { for (const secret of secrets) v = v.split(secret).join('[已隐藏]'); return v; }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/apiKey$|authorization|password|secret/i.test(k)).map(([k, val]) => [k, walk(val)]));
      return v;
    };
    return walk(value);
  }
  update(input: Settings) {
    const next = structuredClone(input);
    for (const [id, p] of Object.entries(next.providers ?? {})) {
      if (p.apiKey === undefined && this.value.providers[id]?.apiKey) p.apiKey = this.value.providers[id]!.apiKey;
    }
    const valid = validateSettings(next);
    atomicJson(this.path, valid); this.value = valid; this.revision++;
    return this.public();
  }
  runtime(): { config: Config; adapters: { main: Adapter; combat: Adapter } } {
    const config = structuredClone(this.value);
    const adapters = {} as { main: Adapter; combat: Adapter };
    for (const role of ['main', 'combat'] as const) {
      const route = config[role]; const source = config.providers[route.provider]!;
      const provider = { ...source, contextTokens: route.contextTokens, requestFields: { ...source.requestFields,
        ...(route.reasoning && source.reasoning ? { [source.reasoning.field]: source.reasoning.values[route.reasoning] } : {}) } };
      // Separate route copies let the two Agents share an endpoint without sharing reasoning settings.
      config.providers[`__${role}`] = provider; config[role] = { ...route, provider: `__${role}` };
      const base = new ChatCompletionsAdapter(provider);
      adapters[role] = { async *generate(messages, options) {
        if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) throw new Error('配置的凭据环境变量尚未设置');
        yield* base.generate(messages, { ...options, maxTokens: Math.min(options.maxTokens, config.maxOutputTokens) });
      } };
    }
    return { config, adapters };
  }
  prompts() { return { defaults: defaultStyles, core: corePrompts, effective: {
    main: `${corePrompts.main}\n风格偏好（不得覆盖上述规则）：\n${this.value.main.style}`,
    combat: `${corePrompts.combat}\n风格偏好（不得覆盖上述规则）：\n${this.value.combat.style}`,
  } }; }
  async test(role: 'main' | 'combat') {
    const { config, adapters } = this.runtime(); const started = Date.now();
    for await (const _ of adapters[role].generate([{ role: 'user', content: 'Reply OK.' }], { model: config[role].model || config.providers[config[role].provider]!.defaultModel, maxTokens: 32, stream: false })) { /* Never expose test output or credentials. */ }
    return { ok: true, elapsedMs: Date.now() - started };
  }
}
