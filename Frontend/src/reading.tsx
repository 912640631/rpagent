import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ReadingPreferences } from './types.ts';

export function useReadingPreferences() {
  const [preferences, setPreferences] = useState<ReadingPreferences>(() => {
    try {
      return { font: 18, animation: true, duration: 900, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        ...JSON.parse(localStorage.getItem('witcher-reading') || '{}') as Partial<ReadingPreferences> };
    } catch { return { font: 18, animation: true, duration: 900, reduced: true }; }
  });
  useEffect(() => {
    try { localStorage.setItem('witcher-reading', JSON.stringify(preferences)); } catch { /* Reading remains usable without storage. */ }
  }, [preferences]);
  return [preferences, setPreferences] as const;
}

export function ReadingControls({ preferences, onChange }: { preferences: ReadingPreferences; onChange: Dispatch<SetStateAction<ReadingPreferences>> }) {
  const update = <K extends keyof ReadingPreferences,>(key: K, value: ReadingPreferences[K]) => onChange(old => ({ ...old, [key]: value }));
  return <details><summary>阅读与骰子</summary>
    <label>字号 {preferences.font}<input aria-label="字号" type="range" min="14" max="26" value={preferences.font} onChange={e => update('font', +e.target.value)}/></label>
    <label><input type="checkbox" checked={preferences.animation} onChange={e => update('animation', e.target.checked)}/>骰子动画</label>
    <label><input type="checkbox" checked={preferences.reduced} onChange={e => update('reduced', e.target.checked)}/>减少动态效果</label>
    <label>动画时长 {preferences.duration} ms<input type="range" min="200" max="1800" step="100" value={preferences.duration} onChange={e => update('duration', +e.target.value)}/></label>
  </details>;
}
