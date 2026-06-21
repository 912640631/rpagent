export interface ToolCall { id: string; name: string; arguments: string }
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  calls?: ToolCall[];
  callId?: string;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface GenerateOptions {
  model: string; tools?: ToolDefinition[]; maxTokens: number;
  stream?: boolean; signal?: AbortSignal;
}
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'call'; call: ToolCall }
  | { type: 'usage'; input: number; output: number }
  | { type: 'reasoning'; text: string }
  | { type: 'done' };
export interface Adapter {
  generate(messages: Message[], options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export interface Provider {
  protocol: 'openai-chat'; baseURL: string; apiKey?: string; apiKeyEnv?: string;
  defaultModel: string; contextTokens: number;
  stream?: boolean; requestFields?: Record<string, unknown>;
}
export interface AgentRoute { provider: string; model?: string }
export interface Config {
  providers: Record<string, Provider>;
  main: AgentRoute; combat: AgentRoute;
  maxOutputTokens: number; recentTokens: number; battleResultTokens: number;
}
