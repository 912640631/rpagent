import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleStoryText } from '../src/web/story-text.js';

const memo = JSON.stringify({ currentSituation: '坠落中；石块含有 } 和 "符文"', necessaryFacts: '女术士在附近', unfinishedActionsAndIntent: '等待玩家应对' });
test('memo projection removes bare and fenced memos while preserving surrounding prose', () => {
  for (const block of [memo, `\`\`\`json\n${memo}\n\`\`\``, `\`\`\`\n${memo}\n\`\`\``]) {
    assert.equal(visibleStoryText(`遗迹崩塌。\n\n${block}`), '遗迹崩塌。');
    assert.equal(visibleStoryText(`前文${block}后文${block}`), '前文后文');
    assert.equal(visibleStoryText(block), '');
  }
});
test('each character-sized streaming update hides memo fields and content', () => {
  for (const block of [memo, `\`\`\`json\n${memo}\n\`\`\``]) {
    const raw = `你要怎么做？\n\n${block}\n后续故事`;
    for (let length = 1; length <= raw.length; length++) {
      const visible = visibleStoryText(raw.slice(0, length), true);
      assert.ok(!visible.includes('currentSituation'), `${length}: ${visible}`);
      assert.ok(!visible.includes('女术士在附近'));
      assert.ok(!visible.includes('```'));
    }
    assert.equal(visibleStoryText(raw, true), '你要怎么做？\n\n\n后续故事');
  }
});
test('ordinary JSON, code, braces and prose are retained', () => {
  for (const text of ['正文', '{"hp":10}', '```json\n{"hp":10}\n```', '```ts\nconst n = 1;\n```', '未闭合 {', '`剑`', '{"currentSituation":"不是完整备忘"}']) {
    assert.equal(visibleStoryText(text), text);
  }
});
test('streaming projection hides an unfinished ordinary JSON block until it is complete', () => {
  assert.equal(visibleStoryText('前文{"hp":', true), '前文');
  assert.equal(visibleStoryText('前文{"hp":10}后文', true), '前文{"hp":10}后文');
});
