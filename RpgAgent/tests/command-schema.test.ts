import assert from 'node:assert/strict';
import test from 'node:test';
import { commandSchema } from 'witcher-combat-engine';
import { combatTools } from '../src/tools.js';
test('RpgAgent embeds the canonical discriminated Command schema', () => {
  const tool = combatTools.find(tool => tool.name === 'battle_act')!;
  assert.deepEqual((tool.parameters.properties as { command: unknown }).command, commandSchema);
});
