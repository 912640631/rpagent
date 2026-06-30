import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { applyAdventureUpdate } from './adventure-updates.ts';
import { diceResults } from './dice-results.ts';
import type { Adventure, AdventureList, AdventureState, EventPayload, ExecutionEvent, DiceResult, Monster, Operation, RunAction, SavedSnapshot } from './types.ts';

/** Owns adventure subscriptions, transport cursors and idempotent submissions. */
export function useAdventure(run: RunAction) {
  const [list, setList] = useState<Adventure[]>([]), [id, setId] = useState<string | null>(null);
  const [state, setState] = useState<AdventureState | null>(null), [events, setEvents] = useState<ExecutionEvent[]>([]), [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState(''), [queue, setQueue] = useState<DiceResult[]>([]);
  const [monsters, setMonsters] = useState<Monster[]>([]);
  const pendingSend = useRef<{ key: string; operationId: string } | null>(null);

  const refresh = async () => {
    const result = await api<AdventureList>('/adventures'); setList(result.adventures); return result;
  };
  useEffect(() => {
    let active = true;
    run(async () => {
      const [adventures, catalog] = await Promise.all([api<AdventureList>('/adventures'), api<Monster[]>('/monsters')]);
      if (!active) return;
      setList(adventures.adventures); setId(adventures.active || null); setMonsters(catalog);
    });
    return () => { active = false; };
  }, [run]);

  useEffect(() => {
    setState(null); setEvents([]); setQueue([]); setConnected(false); pendingSend.current = null;
    if (!id) return;
    let cursor = 0;
    let current: AdventureState | null = null;
    let source: EventSource;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      source = new EventSource(`/api/adventures/${id}/events`);
      source.onmessage = message => {
        try {
          const update = applyAdventureUpdate(current, cursor, JSON.parse(message.data) as EventPayload);
          cursor = update.cursor; current = update.state;
          setConnected(true); setState(current);
          if (update.history) { setEvents(update.events); setQueue([]); return; }
          setEvents(old => [...old, ...update.events]);
          setQueue(old => [...old, ...update.events.flatMap(event => diceResults(event, { forAnimation: true }))]);
        } catch {
          setConnected(false); source.onmessage = null; source.onerror = null; source.close();
          reconnect = setTimeout(connect, 100);
        }
      };
      source.onerror = () => setConnected(false);
    };
    connect();
    return () => { disposed = true; if (reconnect) clearTimeout(reconnect); source.onmessage = null; source.onerror = null; source.close(); };
  }, [id]);

  const queued = async <T,>(message: string, action: () => Promise<T>): Promise<T> => {
    setNotice(message);
    try { return await action(); } finally { setNotice(''); }
  };
  const selectAdventure = (target: string) => queued('切换已排队，等待当前处理完成…', async () => {
    await api(`/adventures/${target}/select`, {}); setId(target); await refresh();
  });
  const select = (target: string) => run(() => selectAdventure(target));
  const create = (name: string) => run(async () => {
    const adventure = await api<Adventure>('/adventures', { name }); await selectAdventure(adventure.id); return adventure;
  });
  const send = (input: string, retry = false) => run(async () => {
    const key = `${id}:${retry}:${retry ? '' : input}`;
    if (pendingSend.current?.key !== key) pendingSend.current = { key, operationId: crypto.randomUUID() };
    const operation = pendingSend.current;
    const result = await api<Operation>(`/adventures/${id}/${retry ? 'retry' : 'turn'}`, {
      ...(retry ? {} : { input }), operationId: operation.operationId
    });
    if (pendingSend.current === operation) pendingSend.current = null;
    return result;
  });
  const save = (name: string) => run(() => queued('保存已排队，等待安全节点…', () => api<SavedSnapshot>(`/adventures/${id}/save`, { name })));
  const restore = (snapshotId: string) => run(() => queued('读档已排队，等待当前处理结束…', () => api<AdventureState>(`/adventures/${id}/restore`, { snapshotId })));
  const testBattle = (monsterId: string) => run(async () => {
    const adventure = await api<Adventure>(`/adventures/${id}/test-battle`, { monsterId }); await selectAdventure(adventure.id);
  });
  const skipDice = useCallback(() => setQueue(old => old.slice(1)), []);
  return { list, id, state, events, connected, notice, queue, monsters, select, create, send, save, restore, testBattle, skipDice };
}
