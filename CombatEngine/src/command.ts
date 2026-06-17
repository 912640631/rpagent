import type { Command } from './types.js';

export function validCommand(value: unknown): value is Command {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  if (command.type === 'decision') {
    return Object.keys(command).every(key => ['type', 'choice'].includes(key)) && typeof command.choice === 'string';
  }
  if (command.type !== 'action' || typeof command.id !== 'string') return false;
  const allowed = ['type', 'id', 'part', 'choice', 'advantage', 'useHopeAdvantage', 'empowerHit', 'empowerDamage'];
  return Object.keys(command).every(key => allowed.includes(key)) &&
    (command.part === undefined || typeof command.part === 'string') &&
    (command.choice === undefined || typeof command.choice === 'string') &&
    (command.advantage === undefined || ['none', 'advantage', 'disadvantage'].includes(command.advantage as string)) &&
    (command.useHopeAdvantage === undefined || typeof command.useHopeAdvantage === 'boolean') &&
    (command.empowerHit === undefined || typeof command.empowerHit === 'boolean') &&
    (command.empowerDamage === undefined || typeof command.empowerDamage === 'boolean');
}
