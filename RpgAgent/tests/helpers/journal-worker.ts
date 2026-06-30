import { AdventureService } from '../../src/web/service.js';
import { ScriptedModel, call, text } from './scripted-model.js';

const [root, id] = process.argv.slice(2);
const service = new AdventureService(root!, { main: new ScriptedModel([
  [...(process.env.WITCHER_TEST_JOURNAL_STAGE === 'after-text' ? [text('未完成输出')] : []), call('narrative_roll', { difficulty: 12 })], [text('河畔')]
]), combat: new ScriptedModel() });
try { service.submit(id!, 'crashed', '查看足迹'); await service.idle(id!); }
finally { await service.close(); }
