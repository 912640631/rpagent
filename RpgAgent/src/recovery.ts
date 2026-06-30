export type RecoveryReason = 'main_context_capacity' | 'combat_context_capacity' | 'other';

export class ContextCapacityError extends Error {
  constructor(readonly reason: Exclude<RecoveryReason, 'other'>, message: string) { super(message); }
}
