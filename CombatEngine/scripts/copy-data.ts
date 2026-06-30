import { cpSync, mkdirSync } from 'node:fs';
mkdirSync(new URL('../dist/data/', import.meta.url), { recursive: true });
cpSync(new URL('../data/combat.json', import.meta.url), new URL('../dist/data/combat.json', import.meta.url));
