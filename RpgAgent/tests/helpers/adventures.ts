import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { AdventureService } from '../../src/web/service.js';

/** Close every reopened service before deleting its temporary saves, including on assertion failure. */
export function temporaryAdventures(t: TestContext, prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const services: AdventureService[] = [];
  t.after(async () => {
    try { for (const service of services) await service.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, open(adapters?: ConstructorParameters<typeof AdventureService>[1]) {
    const service = new AdventureService(root, adapters); services.push(service); return service;
  } };
}
