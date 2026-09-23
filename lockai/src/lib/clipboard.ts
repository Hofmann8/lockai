import { stripToolMarkers } from '@/lib/chat/traces';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文（http 局域网）下 clipboard API 不可用，退回老办法
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** 同时写入 HTML 和纯文本，粘到 Word / 飞书时保留格式，粘到纯文本框时是干净文字 */
export async function copyRich(html: string, plain: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch {
    // 落到纯文本
  }
  return copyText(plain);
}

/** 回答的 markdown 源：去掉内部的工具占位符 */
export function messageMarkdown(content: string): string {
  return stripToolMarkers(content);
}

/** markdown 转成干净的纯文本：粘到微信 / 备忘录里不会满屏星号井号 */
export function markdownToPlain(md: string): string {
  return stripToolMarkers(md)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/<\/?details>|<\/?summary>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
    .replace(/\$\$([\s\S]+?)\$\$/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cellText(cell: Element): string {
  return (cell.textContent || '').replace(/\s+/g, ' ').trim();
}

export function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.rows).map((row) => Array.from(row.cells).map(cellText));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const escape = (v: string) => v.replace(/\|/g, '\\|');
  const [head, ...body] = rows.map(pad);
  return [
    `| ${head.map(escape).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.map(escape).join(' | ')} |`),
  ].join('\n');
}

export function tableToCsv(table: HTMLTableElement): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells).map((cell) => quote(cellText(cell))).join(','))
    .join('\n');
}

export function downloadFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
