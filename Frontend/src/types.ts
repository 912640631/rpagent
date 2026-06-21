import type { AdventureService, Event } from '../../RpgAgent/src/web/service.js';
import type { Settings, SettingsStore } from '../../RpgAgent/src/web/settings.js';
import type { Combatant } from 'witcher-combat-engine';
export type { ExecutionEvent, DiceEvent } from '../../RpgAgent/src/events.js';

// Use the service's public contract without importing server code into the browser.
export type AdventureState = ReturnType<AdventureService['state']>;
export type AdventureList = ReturnType<AdventureService['list']>;
export type Adventure = AdventureList['adventures'][number];
export type SavedSnapshot = Awaited<ReturnType<AdventureService['save']>>;
export type Operation = ReturnType<AdventureService['submit']>;
export interface SettingsResponse {
  value: Settings;
  defaults: Settings;
  prompts: ReturnType<SettingsStore['prompts']>;
  revision: number;
}
export interface Monster { id: string; name: string; difficulty: number; type: string }
export interface ConnectionTest { ok: boolean; elapsedMs: number }
export type RunAction = <T>(action: () => Promise<T>) => Promise<T | undefined>;
export type AgentRole = 'main' | 'combat';

export interface EventPayload { state: AdventureState; events: Event[]; history: boolean }
export interface DieResult { kind: 'hope' | 'fear' | 'd20'; sides: 12 | 20; value: number }
export interface DiceResult { id: string; label: string; dice: DieResult[]; total?: number }
export interface ReadingPreferences { font: number; animation: boolean; duration: number; reduced: boolean }
export type CharacterCard = Pick<Combatant, 'hp' | 'armor' | 'signPoints' | 'toxicity' | 'statuses' | 'potions' | 'dead'> &
  Partial<Pick<Combatant, 'maxHp' | 'maxArmor' | 'maxSignPoints' | 'maxToxicity'>>;
