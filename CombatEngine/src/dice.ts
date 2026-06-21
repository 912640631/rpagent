import type { BattleState } from './types.js';

export function nextRandom(state: Pick<BattleState, 'randomState'>): number {
  let value = state.randomState >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.randomState = value >>> 0;
  return state.randomState / 0x100000000;
}

export function rollDie(state: BattleState, sides: number): number {
  if (!Number.isSafeInteger(sides) || sides < 2) throw new Error(`Invalid die: d${sides}`);
  return 1 + Math.floor(nextRandom(state) * sides);
}

export function rollFormula(state: BattleState, formula: string): number {
  const compact = formula.replace(/\s+/g, '');
  const pieces = compact.match(/[+-]?[^+-]+/g);
  if (!pieces || pieces.join('') !== compact) throw new Error(`Invalid dice formula: ${formula}`);
  let total = 0;
  for (const piece of pieces) {
    const sign = piece.startsWith('-') ? -1 : 1;
    const body = piece.replace(/^[+-]/, '');
    const die = /^(\d*)d(\d+)$/i.exec(body);
    if (die) {
      const count = die[1] ? Number(die[1]) : 1;
      const sides = Number(die[2]);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error(`Invalid dice formula: ${formula}`);
      for (let i = 0; i < count; i++) total += sign * rollDie(state, sides);
    } else if (/^\d+$/.test(body)) {
      total += sign * Number(body);
    } else {
      throw new Error(`Invalid dice formula: ${formula}`);
    }
  }
  return total;
}

export function baseDie(formula: string): string {
  const match = /(\d*)d(\d+)/i.exec(formula);
  if (!match) throw new Error(`Formula has no base die: ${formula}`);
  return `1d${match[2]}`;
}
