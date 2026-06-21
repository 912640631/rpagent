import type { DiceEvent, DiceResult, DieResult } from './types.ts';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Consume recorded values only. Historical recovered results remain visible without replaying animations.
export function diceResults(event: DiceEvent, { forAnimation = false }: { forAnimation?: boolean } = {}): DiceResult[] {
  if (event.type !== 'tool.result') return [];
  const result = record(event.result);
  if (forAnimation && result?.recovered) return [];
  const items: DiceResult[] = [];
  const add = (value: unknown, label: string) => {
    const data = record(value);
    const dice = Object.entries(record(data?.dice) ?? {}).flatMap(([kind, value]): DieResult[] => {
      if (kind !== 'hope' && kind !== 'fear' && kind !== 'd20') return [];
      const sides = kind === 'hope' || kind === 'fear' ? 12 : kind === 'd20' ? 20 : null;
      return sides && typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= sides ? [{ kind, value, sides }] : [];
    });
    if (dice.length) items.push({ id: `${event.id}-${items.length}`, label, dice, total: typeof data?.total === 'number' ? data.total : undefined });
  };
  if (event.call?.name === 'narrative_roll') add(result?.result, '叙事判定');
  for (const value of Array.isArray(result?.events) ? result.events : []) {
    const rule = record(value), details = record(rule?.details);
    add(rule?.type === 'dying_roll' ? { dice: details } : details, rule?.type === 'dying_roll' ? '濒死赌博' : '战斗判定');
    if (rule?.type === 'damage' && typeof details?.rolled === 'number') items.push({ id: `${event.id}-${items.length}`, label: '伤害汇总', dice: [], total: details.rolled });
  }
  return items;
}
