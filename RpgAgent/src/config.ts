import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ChatCompletionsAdapter } from './adapter.js';
import type { Adapter, AgentRoute, Config } from './types.js';

export function loadConfig(path: string): Config {
  const config: Config = JSON.parse(readFileSync(path, 'utf8'));
  for (const route of [config.main, config.combat]) {
    const p = config.providers?.[route?.provider];
    if (!p || p.protocol !== 'openai-chat' || !p.defaultModel || !/^https?:\/\//.test(p.baseURL)) {
      throw new Error('Provider 配置无效：需要 openai-chat、baseURL 和 defaultModel');
    }
    if (!Number.isSafeInteger(p.contextTokens) || p.contextTokens < 4096) throw new Error('contextTokens 至少为 4096');
    if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) throw new Error(`缺少环境变量 ${p.apiKeyEnv}`);
  }
  for (const field of ['maxOutputTokens', 'recentTokens', 'battleResultTokens'] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) throw new Error(`配置 ${field} 必须是正整数`);
  }
  for (const p of Object.values(config.providers)) {
    if (config.maxOutputTokens >= p.contextTokens / 2) throw new Error('输出预算必须小于上下文容量的一半');
  }
  return config;
}

export function resolveRoute(config: Config, route: AgentRoute): { adapter: Adapter; model: string; contextTokens: number } {
  const provider = config.providers[route.provider]!;
  return { adapter: new ChatCompletionsAdapter(provider), model: route.model?.trim() || provider.defaultModel, contextTokens: provider.contextTokens };
}

/** Explicit local bootstrap; source credentials and generated config stay outside version control. */
export function initConfig(source: string, destination: string): void {
  if (existsSync(destination)) throw new Error('配置已存在，不覆盖。');
  const text = readFileSync(source, 'utf8');
  const sections = [...text.matchAll(/(?:^|\n)(local|deepseek)[:：]\s*\n([\s\S]*?)(?=\n(?:local|deepseek)[:：]|$)/g)];
  const providers: Config['providers'] = {};
  for (const [, id, section] of sections) {
    const baseURL = section!.match(/base(?:URL|_url)[^:：\n]*[:：]\s*(https?:\/\/[^\s]+)/i)?.[1];
    const apiKey = section!.match(/apiKey[:：]\s*([^\s]+)/i)?.[1];
    const defaultModel = section!.match(/- id:\s*([^\s]+)/)?.[1] ?? section!.match(/model[:：]\s*\n\s*([^\s]+)/)?.[1];
    if (baseURL && apiKey && defaultModel) providers[id!] = {
      protocol: 'openai-chat', baseURL, apiKey, defaultModel, contextTokens: 32768
    };
  }
  const first = Object.keys(providers)[0];
  if (!first) throw new Error('接入文件没有可识别的 Provider');
  const config: Config = { providers, main: { provider: first }, combat: { provider: first },
    maxOutputTokens: 2048, recentTokens: 6000, battleResultTokens: 1500 };
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
}
