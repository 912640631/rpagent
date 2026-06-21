import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { DiceResult, DieResult, ReadingPreferences } from './types.ts';

function Die({ die, duration, animate }: { die: DieResult; duration: number; animate: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = mount.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); } catch { return; }
    renderer.setSize(112, 112); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); node.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100); camera.position.z = 5;
    const geometry = die.sides === 12 ? new THREE.DodecahedronGeometry(1) : new THREE.IcosahedronGeometry(1);
    const color = die.kind === 'hope' ? '#318778' : die.kind === 'fear' ? '#845571' : '#9b7842';
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.46, metalness: 0.24, flatShading: true });
    const mesh = new THREE.Mesh(geometry, material); scene.add(mesh);
    const edges = new THREE.EdgesGeometry(geometry); const lineMaterial = new THREE.LineBasicMaterial({ color: '#eee0b8' });
    mesh.add(new THREE.LineSegments(edges, lineMaterial));
    scene.add(new THREE.AmbientLight('#fff2d7', 2)); const light = new THREE.DirectionalLight('#ffffff', 4); light.position.set(3, 4, 5); scene.add(light);
    let frame: number; const start = performance.now();
    const draw = (now: number) => {
      const progress = animate ? Math.min((now - start) / duration, 1) : 1;
      const remaining = (1 - progress) ** 3;
      mesh.rotation.set(0.25 + remaining * 8, 0.3 + remaining * 12, remaining * 6);
      renderer.render(scene, camera); if (progress < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); renderer.dispose(); geometry.dispose(); material.dispose(); edges.dispose(); lineMaterial.dispose(); renderer.domElement.remove(); };
  }, [die.sides, die.kind, duration, animate]);
  return <div className={`die ${die.kind}`}><div className="die-shape" ref={mount}><strong>{die.value}</strong></div><span>{die.kind === 'hope' ? '☀ 希望' : die.kind === 'fear' ? '☾ 绝望' : '◆ 怪物'} · d{die.sides}</span></div>;
}
export function Dice({ result, preferences, onSkip }: { result?: DiceResult; preferences: ReadingPreferences; onSkip: () => void }) {
  if (!result) return null;
  const animate = preferences.animation && !preferences.reduced;
  return <section className="dice-card" aria-label="真实骰子结果"><div className="section-heading"><span>{result.label}</span><button onClick={onSkip}>跳过 / 收起</button></div><div className="dice-row">{result.dice.map(d => <Die key={d.kind} die={d} duration={preferences.duration} animate={animate}/>)}</div>{result.total !== undefined && <p>规则{result.dice.length ? '总值' : '汇总值'} <b>{result.total}</b></p>}<small>{result.dice.length ? '引擎已判定 · 后台继续运行' : '未提供逐骰值，仅展示真实汇总'}</small></section>;
}
