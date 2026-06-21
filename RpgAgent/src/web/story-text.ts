/** Project raw Agent output into player-visible prose without changing saved context. */
export function visibleStoryText(text: string, streaming = false): string {
  let visible = '', index = 0, removed = false;
  while (index < text.length) {
    if (text[index] === '`') {
      const rest = text.slice(index);
      if (streaming && /^`{1,2}$/.test(rest)) break;
      if (rest.startsWith('```')) {
        const header = text.indexOf('\n', index + 3);
        if (header === -1) {
          if (streaming) break;
        } else {
          const end = text.indexOf('```', header + 1);
          if (end === -1 && streaming) break;
          const stop = end === -1 ? text.length : end + 3;
          const content = text.slice(header + 1, end === -1 ? text.length : end).trim();
          if (isMemo(content)) removed = true;
          else visible += text.slice(index, stop);
          index = stop;
          continue;
        }
      }
    }
    if (text[index] === '{') {
      const end = objectEnd(text, index);
      if (end === -1) {
        if (streaming) break;
      } else {
        const candidate = text.slice(index, end);
        if (isMemo(candidate)) removed = true;
        else visible += candidate;
        index = end;
        continue;
      }
    }
    visible += text[index++];
  }
  return removed ? visible.trimEnd() : visible;
}

function isMemo(text: string): boolean {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      ['currentSituation', 'necessaryFacts', 'unfinishedActionsAndIntent'].every(key => typeof value[key] === 'string');
  } catch { return false; }
}

/** Braces inside JSON strings, including escaped quotes, do not close the object. */
function objectEnd(text: string, start: number): number {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
