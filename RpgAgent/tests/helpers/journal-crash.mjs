import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';

const target = resolve(process.env.WITCHER_TEST_JOURNAL);
const stage = process.env.WITCHER_TEST_JOURNAL_STAGE;
const append = fs.appendFileSync;
fs.appendFileSync = function (path, data, options) {
  if (resolve(String(path)) !== target) return append(path, data, options);
  const record = JSON.parse(String(data));
  if (stage === 'after-text' && record.event?.type === 'request.chunk' && record.event.chunk.type === 'text') {
    append(path, data, options); process.exit(74);
  }
  if (stage === 'before-tool' && record.kind === 'checkpoint' && record.checkpoint?.pending) {
    append(path, data, options); process.exit(74);
  }
  if (stage === 'after-rule' && record.event?.type === 'tool.result') process.exit(74);
  if (stage === 'partial-input' && record.event?.type === 'input.accepted' ||
      stage === 'partial-tool-result' && record.event?.type === 'tool.result') {
    append(path, String(data).slice(0, Math.floor(String(data).length / 2)), options); process.exit(74);
  }
  return append(path, data, options);
};
syncBuiltinESMExports();
