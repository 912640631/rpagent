import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// Runs only in the crash-test child. Inject failure at the filesystem boundary,
// after the real atomic replacement has completed, without mocking application modules.
const directory = resolve(process.env.WITCHER_TEST_RESTORE_DIRECTORY);
const target = join(directory, process.env.WITCHER_TEST_RESTORE_EXIT_AFTER);
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const result = rename(from, to);
  if (resolve(String(to)) === target && dirname(target) === directory && fs.existsSync(join(directory, 'restore.json'))) {
    process.exit(73);
  }
  return result;
};
syncBuiltinESMExports();
