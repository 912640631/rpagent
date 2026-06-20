/** Structural DSH inbox boundary; the engine does not import the harness. */
export interface PlayerInputMessage {
  readonly id: string;
  readonly source: { readonly kind: string };
  readonly content: readonly unknown[];
}

export interface BattleInputAgent<M extends PlayerInputMessage = PlayerInputMessage> {
  readonly inbox: {
    readonly nextTurn: readonly M[];
    readonly nextStep: readonly M[];
    remove(messageId: M['id']): boolean;
  };
}

export type OnPlayerInput<M extends PlayerInputMessage, A extends BattleInputAgent<M>> =
  (listener: (event: { agent: A; message: M }) => void) => () => void;

/** One cancellable pending tool per agent, settled only by direct human input. */
export class BattleInput<
  M extends PlayerInputMessage = PlayerInputMessage,
  A extends BattleInputAgent<M> = BattleInputAgent<M>,
> {
  private readonly waits = new Map<A, { accept(message: M): void; reject(reason: unknown): void }>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(onInsert: OnPlayerInput<M, A>) {
    this.unsubscribe = onInsert(({ agent, message }) => this.waits.get(agent)?.accept(message));
  }

  waitForPlayerAction(agent: A, signal: AbortSignal): Promise<M> {
    if (this.disposed) return Promise.reject(new Error('Battle input is disposed'));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.waits.has(agent)) return Promise.reject(new Error('An input wait is already pending for this agent'));
    return new Promise<M>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        this.waits.delete(agent);
        signal.removeEventListener('abort', abort);
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        cleanup();
        reject(reason);
      };
      const abort = () => fail(signal.reason);
      const accept = (message: M) => {
        if (settled || message.source.kind !== 'user') return;
        if (signal.aborted) { abort(); return; }
        try {
          // Public remove commits the exact inbox removal before resolving the tool.
          // The original identity/content returns in its result, not as another turn.
          if (!agent.inbox.remove(message.id)) return;
          if (settled) return;
          cleanup();
          resolve(message);
        } catch (error) { fail(error); }
      };
      this.waits.set(agent, { accept, reject: fail });
      signal.addEventListener('abort', abort, { once: true });
      // Match DSH admission priority: steering first, then the queued turn.
      // Snapshot because accepting one message mutates the live projection.
      for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
        accept(message);
        if (settled) break;
      }
    });
  }

  cancel(agent: A): void {
    this.waits.get(agent)?.reject(new Error('Battle input agent disposed'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const wait of [...this.waits.values()]) wait.reject(new Error('Battle input is disposed'));
  }
}
