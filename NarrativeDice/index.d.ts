export interface NarrativeState {
  version: 1;
  hope: number;
  fear: number;
  history: Array<{ id: number; type: string; at: string; result: unknown }>;
}

export class DiceError extends Error {
  code: string;
}

export function initialState(): NarrativeState;
export function resolveRoll(
  state: NarrativeState,
  input: { difficulty: number; modifier?: number; useHopeAdvantage?: boolean },
  rollDie?: () => number
): { state: NarrativeState; result: Record<string, unknown> };
export function resolveFearSpend(state: NarrativeState): {
  state: NarrativeState;
  result: Record<string, unknown>;
};
