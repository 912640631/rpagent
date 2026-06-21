export { combatData, dataRevision, monsterIds, validateCombatData } from './data.js';
export { createBattle, getOptions, getBattleView, advanceBattle } from './engine.js';
export { chooseTestCommand, simulateBattle } from './policy.js';
export { createCombatSession, defaultSessionPath } from './session.js';
export { createAdventureSession, defaultAdventurePath, AdventureError } from './adventure-session.js';
export { createBattleHandoff } from './battle-handoff.js';
export type { BattleHandoffContext, BattleHandoffStatus, BattleSettlement } from './battle-handoff.js';
export { BattleInput } from './battle-input.js';
export type { BattleInputAgent, PlayerInputMessage, OnPlayerInput } from './battle-input.js';
export type { CombatSession, SessionErrorCode, SessionFailure, SessionResult, SessionSuccess } from './session.js';
export type { CombatantSummary, SessionDecisionOption, SessionOption, SessionView, TargetPartSummary } from './session-view.js';
export type {
  ActionCommand, ActionOption, Advantage, BattleConfig, BattleState, BattleView, Combatant,
  Command, DamageRank, DecisionCommand, Event, Outcome, PendingDecision, Side
} from './types.js';

export { commandSchema, validCommand } from './command.js';
export { actionId, parseActionId, actionRules, findActionRule } from './action-rules.js';
export type { ActionCategory, ActionIdentifier, ActionRule } from './action-rules.js';
