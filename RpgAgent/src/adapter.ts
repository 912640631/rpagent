import type { Adapter, GenerateOptions, Message, Provider, StreamChunk, ToolCall } from './types.js';

export class ModelError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

/** All Chat Completions wire fields and SSE handling live at this boundary. */
export class ChatCompletionsAdapter implements Adapter {
  constructor(private readonly provider: Provider) {}

  async *generate(messages: Message[], options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const key = this.provider.apiKeyEnv ? process.env[this.provider.apiKeyEnv] : this.provider.apiKey;
    const stream = options.stream ?? this.provider.stream ?? true;
    const body = {
      ...this.provider.requestFields,
      model: options.model,
      messages: messages.map(m => ({
        role: m.role, content: m.content || (m.calls?.length ? null : ''),
        ...(m.callId ? { tool_call_id: m.callId } : {}),
        ...(m.calls?.length ? { tool_calls: m.calls.map(c => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments }
        })) } : {})
      })),
      ...(options.tools?.length ? { tools: options.tools.map(t => ({ type: 'function', function: t })) } : {}),
      max_tokens: options.maxTokens, stream,
      ...(stream ? { stream_options: { include_usage: true } } : {})
    };
    let response: Response;
    try {
      response = await fetch(`${this.provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body), signal: options.signal ?? AbortSignal.timeout(120_000)
      });
    } catch { throw new ModelError('模型通道连接失败或超时；已保留存档。'); }
    // Do not echo provider bodies: they may contain credentials or private prompts.
    if (!response.ok) throw new ModelError(`模型通道返回 HTTP ${response.status}`, response.status);
    if (!stream) {
      let data: any;
      try { data = await response.json(); } catch { throw new ModelError('模型返回的 JSON 无效'); }
      if (data.error || !data.choices?.[0]?.message) throw new ModelError('模型返回缺少消息');
      const message = data.choices[0].message;
      if (message.reasoning_content) yield { type: 'reasoning', text: message.reasoning_content };
      if (message.content) yield { type: 'text', text: message.content };
      for (const call of message.tool_calls ?? []) {
        yield { type: 'call', call: { id: call.id, name: call.function.name, arguments: call.function.arguments } };
      }
      if (data.usage) yield { type: 'usage', input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
      yield { type: 'done' }; return;
    }
    if (!response.body) throw new ModelError('模型返回空流');
    const calls = new Map<number, ToolCall>();
    let finished = false;
    for await (const event of sse(response.body)) {
      if (event === '[DONE]') { finished = true; break; }
      let data: any;
      try { data = JSON.parse(event); } catch { throw new ModelError('模型返回无效 SSE 数据'); }
      if (data.error) throw new ModelError('模型流返回错误');
      const choice = data.choices?.[0];
      if (choice?.finish_reason) finished = true;
      if (choice?.delta?.content) yield { type: 'text', text: choice.delta.content };
      if (choice?.delta?.reasoning_content) yield { type: 'reasoning', text: choice.delta.reasoning_content };
      for (const fragment of choice?.delta?.tool_calls ?? []) {
        const call = calls.get(fragment.index) ?? { id: '', name: '', arguments: '' };
        call.id += fragment.id ?? '';
        call.name += fragment.function?.name ?? '';
        call.arguments += fragment.function?.arguments ?? '';
        calls.set(fragment.index, call);
      }
      if (data.usage) yield { type: 'usage', input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
    }
    if (!finished) throw new ModelError('模型流提前中断；未执行其中的工具调用。');
    for (const call of calls.values()) {
      if (!call.id || !call.name) throw new ModelError('模型工具调用不完整');
      yield { type: 'call', call };
    }
    yield { type: 'done' };
  }
}

/** Handles UTF-8 splits, CRLF, multiple data lines, and frames split across reads. */
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield data;
      }
      if (done) break;
    }
    if (buffer.trim().startsWith('data:')) yield buffer.trim().slice(5).trimStart();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
