import type { Provider } from '../types.js';

export interface ModelDirectory { models: { id: string }[] }

/** Read the advertised catalogue; a listed model has not necessarily passed a generation test. */
export async function providerModels(provider: Provider): Promise<ModelDirectory> {
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : provider.apiKey;
  if (provider.apiKeyEnv && !key) throw new Error('配置的凭据环境变量尚未设置');
  let response: Response;
  try {
    response = await fetch(`${provider.baseURL.replace(/\/$/, '')}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000)
    });
  } catch { throw new Error('模型目录连接失败或超时，请检查连接后重试'); }
  if (!response.ok) throw new Error(`模型目录返回 HTTP ${response.status}`);
  let value: unknown;
  try { value = await response.json(); } catch { throw new Error('模型目录返回无效 JSON'); }
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data) ||
      value.data.some(item => !item || typeof item.id !== 'string' || !item.id.trim())) {
    throw new Error('模型目录格式无效，需要 data 数组和模型 ID');
  }
  const ids = new Set<string>(value.data.map(item => item.id.trim()));
  return { models: [...ids].sort().map(id => ({ id })) };
}
