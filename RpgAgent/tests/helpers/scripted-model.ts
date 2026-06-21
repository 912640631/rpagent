import assert from 'node:assert/strict';
import type { Adapter, GenerateOptions, Message, StreamChunk } from '../../src/types.js';

/** A scripted external model boundary; the real Harness, rules and persistence stay in use. */
export class ScriptedModel implements Adapter {
  readonly inputs: Message[][] = [];
  readonly options: GenerateOptions[] = [];
  constructor(readonly responses: StreamChunk[][] = []) {}
  async *generate(messages: Message[], options: GenerateOptions) {
    this.inputs.push(structuredClone(messages)); this.options.push(options);
    const response = this.responses.shift();
    assert.ok(response, 'unexpected external model request');
    yield* response;
  }
}
export const text = (value: string): StreamChunk => ({ type: 'text', text: value });
export const call = (name: string, args: unknown = {}): StreamChunk => ({ type: 'call',
  call: { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) } });
