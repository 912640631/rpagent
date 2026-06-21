export async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    throw new Error(typeof error === 'string' ? error : '请求失败');
  }
  return result as T;
}
