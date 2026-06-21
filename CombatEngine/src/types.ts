export type Side = 'geralt' | 'monster';
export type Advantage = 'none' | 'advantage' | 'disadvantage';
export type DamageRank = 'none' | 'light' | 'heavy' | 'severe';
export type Outcome = 'geralt_won' | 'geralt_incapacitated' | 'geralt_dead' | 'monster_escaped' | 'action_limit';

interface EffectLifetime {
  remaining?: number; uses?: number; startAfterCompleted?: number; untilNextAttack?: boolean;
}
export type TimedEffect = EffectLifetime & (
  | { kind: 'stat'; stat: import('./rule-types.js').Stat; value: number }
  | { kind: 'immunity'; status: import('./rule-types.js').StatusId }
  | { kind: 'yrden' }
  | { kind: 'quen' }
  | { kind: 'disabled_tag'; tag: string }
  | { kind: 'disabled_action'; action: string }
  | { kind: 'axii_bonus'; target: Side; uses: number }
);

export interface Combatant {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  defense: number;
  heavyThreshold: number;
  severeThreshold: number;
  armor: number;
  maxArmor: number;
  signPoints: number;
  maxSignPoints: number;
  toxicity: number;
  maxToxicity: number;
  statuses: Record<string, number>;
  trauma: Record<string, number>;
  effects: TimedEffect[];
  nextAttackDice: string[];
  thunderboltUses: number;
  potions: string[];
  completedActions: number;
  dead: boolean;
}

export interface Event {
  sequence: number;
  type: string;
  actor?: Side;
  target?: Side;
  details: Record<string, unknown>;
}

export interface PendingDecision {
  kind: 'dying' | 'bonus_action';
  options: string[];
  resume: 'finish_action' | 'resolve_initiative';
  actingSide: Side;
  initiativeAfter: Side;
}

export interface BattleState {
  version: 1;
  dataRevision: string;
  seed: number;
  randomState: number;
  monsterId: string;
  combatants: Record<Side, Combatant>;
  initiative: Side;
  fear: number;
  hope: number;
  actionCount: number;
  maxActions: number;
  pending: PendingDecision | null;
  forcedGeraltInitiative: boolean;
  outcome: Outcome | null;
  events: Event[];
}

export interface InitialCombatantState {
  hp?: number;
  armor?: number;
  signPoints?: number;
  toxicity?: number;
  statuses?: Record<string, number>;
  trauma?: Record<string, number>;
  potions?: string[];
}

export interface BattleConfig {
  monsterId: string;
  seed?: number;
  maxActions?: number;
  initiative?: Side;
  fear?: number;
  hope?: number;
  initial?: Partial<Record<Side, InitialCombatantState>>;
}

export interface ActionOption {
  id: string;
  name: string;
  actor: Side;
  kind: 'attack' | 'sign' | 'potion' | 'action' | 'clear';
  targetParts?: string[];
  choices?: string[];
  cost?: Record<string, number>;
  canEmpowerHit?: boolean;
  canEmpowerDamage?: boolean;
}

export type { ActionCommand, DecisionCommand, Command } from './command.js';

export interface BattleView {
  state: BattleState;
  options: ActionOption[];
}
