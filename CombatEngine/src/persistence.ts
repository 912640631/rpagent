import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function atomicJson(path: string, value: unknown): void {
  atomicText(path, JSON.stringify(value));
}

/** Directory locks protect short rule transactions, not a process lifetime. */
export function withFileLock<T>(path: string, operation: () => T, busy: () => Error = () => new Error('SESSION_BUSY')): T {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const owner = join(lock, 'owner');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { mkdirSync(lock); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (existsSync(owner)) {
          const pid = Number(readFileSync(owner, 'utf8'));
          if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid transaction lock owner');
          try { process.kill(pid, 0); }
          catch (ownerError) {
            if ((ownerError as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(owner); rmdirSync(lock); }
            else if ((ownerError as NodeJS.ErrnoException).code !== 'EPERM') throw ownerError;
          }
        } else if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
      } catch (staleError) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((staleError as NodeJS.ErrnoException).code ?? '')) throw staleError;
      }
      Atomics.wait(pause, 0, 0, 25);
    }
  }
  if (!acquired) throw busy();
  try { writeFileSync(owner, String(process.pid), { flag: 'wx' }); return operation(); }
  finally { if (existsSync(owner)) unlinkSync(owner); rmdirSync(lock); }
}
