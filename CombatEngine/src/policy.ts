import { advanceBattle, getOptions } from './engine.js';
import type { ActionCommand, BattleState, Command } from './types.js';

/** A deliberately simple controller for repeatable engine checks, not combat strategy. */
export function chooseTestCommand(state: BattleState): Command {
  if (state.pending) {
    if (state.pending.kind === 'dying') return { type: 'decision', choice: 'gamble' };
    return { type: 'decision', choice: 'skip' };
  }
  const options = getOptions(state);
  if (!options.length) throw new Error('No legal action for active side');
  if (state.initiative === 'geralt') {
    const swallow = options.find(option => option.id === 'potion:swallow');
    if (state.combatants.geralt.hp <= 2 && swallow) return { type: 'action', id: swallow.id };
    const sword = options.find(option => option.id === 'sword:normal')!;
    return { type: 'action', id: sword.id, advantage: 'none' };
  }
  const attacks = options.filter(option => option.kind === 'attack');
  if (!attacks.length) return { type: 'action', id: options[0]!.id };
  const selected = attacks[state.actionCount % attacks.length] ?? attacks[0]!;
  const command: ActionCommand = { type: 'action', id: selected.id, advantage: 'none' };
  return command;
}

export function simulateBattle(initial: BattleState): BattleState {
  let current = initial;
  let decisions = 0;
  while (!current.outcome) {
    current = advanceBattle(current, chooseTestCommand(current));
    decisions++;
    if (decisions > initial.maxActions * 4 + 20) throw new Error('Simulation failed to terminate');
  }
  return current;
}
