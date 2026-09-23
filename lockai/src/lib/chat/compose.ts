/** 输入框里的一段"粘贴成附件"的长文本 */
export interface PastedBlock {
  id: string;
  text: string;
}

export interface ComposerDraft {
  text: string;
  images: string[];
  quotes: string[];
  pastes: PastedBlock[];
}

export const EMPTY_DRAFT: ComposerDraft = { text: '', images: [], quotes: [], pastes: [] };

/** 超过这个长度的粘贴会收成一个附件块，避免把输入框撑爆 */
export const LONG_PASTE_THRESHOLD = 1600;

export function isDraftEmpty(draft: ComposerDraft): boolean {
  return !draft.text.trim() && draft.images.length === 0 && draft.quotes.length === 0 && draft.pastes.length === 0;
}

/**
 * 把输入框的几块内容拼成最终发出去的一条 markdown：
 *   > 引用
 *
 *   正文
 *
 *   <details> 粘贴的长文本 </details>
 * 引用用 blockquote，长文本折叠起来，回看历史时也不占地方。
 */
export function composeMessage(draft: ComposerDraft): string {
  const blocks: string[] = [];
  for (const quote of draft.quotes) {
    const lines = quote.trim().split('\n').map((line) => `> ${line}`);
    blocks.push(lines.join('\n'));
  }
  if (draft.text.trim()) blocks.push(draft.text.trim());
  for (const paste of draft.pastes) {
    const count = paste.text.length;
    blocks.push(`<details><summary>粘贴的内容 · ${count} 字</summary>\n\n${paste.text.trim()}\n\n</details>`);
  }
  return blocks.join('\n\n');
}

/** 把一条已发出的用户消息拆回输入框（编辑重发时用） */
export function decomposeMessage(content: string): Pick<ComposerDraft, 'text' | 'quotes' | 'pastes'> {
  const pastes: PastedBlock[] = [];
  let rest = content.replace(/<details><summary>粘贴的内容[^<]*<\/summary>\n\n([\s\S]*?)\n\n<\/details>/g, (_, body: string) => {
    pastes.push({ id: crypto.randomUUID(), text: body });
    return '';
  });
  const quotes: string[] = [];
  const quoteRe = /^((?:> .*(?:\n|$))+)\n?/;
  let match = quoteRe.exec(rest);
  while (match) {
    quotes.push(match[1].split('\n').filter(Boolean).map((line) => line.replace(/^> ?/, '')).join('\n'));
    rest = rest.slice(match[0].length);
    match = quoteRe.exec(rest);
  }
  return { text: rest.trim(), quotes, pastes };
}
