/**
 * 修复不完整的 Markdown 文本，确保流式输出时格式正确
 */
const TRAILING_CLOSING_PUNCTUATION_RE = /([)"'\]}>”’）］｝〕〗〙〛」』】〉》]+)$/u;
const MARKDOWN_WRAPPER_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
  '“': '”',
  '‘': '’',
  '（': '）',
  '［': '］',
  '｛': '｝',
  '〔': '〕',
  '〖': '〗',
  '〘': '〙',
  '〚': '〛',
  '「': '」',
  '『': '』',
  '【': '】',
  '〈': '〉',
  '《': '》',
};

function appendAutoClosedMarker(text: string, marker: string, markerIndex: number): string {
  if (markerIndex < 0) return text;

  const trailing = text.slice(markerIndex + marker.length);
  const trailingClosers = trailing.match(TRAILING_CLOSING_PUNCTUATION_RE)?.[0];
  if (!trailingClosers) {
    return text + marker;
  }

  const prefixOpener = text[markerIndex - 1];
  const matchingCloser = prefixOpener ? MARKDOWN_WRAPPER_PAIRS[prefixOpener] : undefined;
  if (!matchingCloser) {
    return text + marker;
  }

  const closerOffset = trailingClosers.indexOf(matchingCloser);
  if (closerOffset === -1) {
    return text + marker;
  }

  const contentBeforeCloser = trailing.slice(0, trailing.length - trailingClosers.length + closerOffset).trim();
  if (!contentBeforeCloser) {
    return text + marker;
  }

  const insertAt = text.length - trailingClosers.length + closerOffset;
  return `${text.slice(0, insertAt)}${marker}${text.slice(insertAt)}`;
}

/**
 * 修复 emphasis 标记（** * ~~）紧邻 CJK 标点时 micromark 无法识别 flanking 的问题。
 * 在标记与相邻的 Unicode 标点/CJK 字符之间插入零宽空格，使解析器正确识别 delimiter。
 */
const CJK_PUNCT =
  '\u2018\u2019\u201C\u201D' +                       // ''""
  '\u3001\u3002\u3008-\u3011\u3014-\u301B' +         // 、。〈〉《》「」『』【】〔〕〖〗〘〙〚〛
  '\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65' + // ！＂…全角标点
  '\uFE30-\uFE4F';                                   // CJK 兼容标点
const EMPHASIS_FLANKING_RE = new RegExp(
  // group 1: closing punctuation directly before opening marker
  `([${CJK_PUNCT}])(\\*{1,2}|~~)(?=[^\\s*~])` +
  '|' +
  // group 3: closing marker directly followed by opening punctuation
  `(?<=[^\\s*~])(\\*{1,2}|~~)([${CJK_PUNCT}])`,
  'gu',
);
const ZWS = '\u200B';

export function fixEmphasisFlanking(text: string): string {
  return text.replace(EMPHASIS_FLANKING_RE, (...m) => {
    // m[1],m[2] = first alternative (punct before marker)
    // m[3],m[4] = second alternative (marker before punct)
    if (m[1] && m[2]) return `${m[1]}${ZWS}${m[2]}`;
    if (m[3] && m[4]) return `${m[3]}${ZWS}${m[4]}`;
    return m[0];
  });
}

export function fixIncompleteMarkdown(text: string): string {
  let result = text;
  
  // 修复未闭合的粗体 **
  const boldCount = (result.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    // 找到最后一个 ** 的位置
    const lastBoldIndex = result.lastIndexOf('**');
    if (lastBoldIndex !== -1) {
      // 检查是否是开始标记（后面有内容）
      const afterBold = result.slice(lastBoldIndex + 2);
      if (afterBold.length > 0 && !afterBold.startsWith(' ') && !afterBold.startsWith('\n')) {
        result = appendAutoClosedMarker(result, '**', lastBoldIndex);
      }
    }
  }
  
  // 修复未闭合的斜体 *（单个）
  // 先移除已配对的 ** 再计算
  const withoutBold = result.replace(/\*\*/g, '');
  const italicCount = (withoutBold.match(/\*/g) || []).length;
  if (italicCount % 2 !== 0) {
    const lastItalicIndex = result.lastIndexOf('*');
    // 确保不是 ** 的一部分
    if (lastItalicIndex !== -1 && result[lastItalicIndex - 1] !== '*' && result[lastItalicIndex + 1] !== '*') {
      result = appendAutoClosedMarker(result, '*', lastItalicIndex);
    }
  }
  
  // 修复未闭合的行内代码 `
  const codeCount = (result.match(/`/g) || []).length;
  // 排除代码块 ```
  const codeBlockCount = (result.match(/```/g) || []).length;
  const inlineCodeCount = codeCount - codeBlockCount * 3;
  if (inlineCodeCount % 2 !== 0) {
    result = appendAutoClosedMarker(result, '`', result.lastIndexOf('`'));
  }
  
  // 修复未闭合的代码块 ```
  if (codeBlockCount % 2 !== 0) {
    result += '\n```';
  }
  
  // 修复未闭合的删除线 ~~
  const strikeCount = (result.match(/~~/g) || []).length;
  if (strikeCount % 2 !== 0) {
    result = appendAutoClosedMarker(result, '~~', result.lastIndexOf('~~'));
  }
  
  return result;
}
