import type { ChatMessage } from '@/types';
import { stripToolMarkers } from './traces';

/** 整段对话导出成 markdown：用户说的话引用起来，回答原样保留，工具结果附在下面 */
export function conversationToMarkdown(title: string, messages: ChatMessage[]): string {
  const lines: string[] = [`# ${title || 'LockAI 对话'}`, '', `> 导出于 ${new Date().toLocaleString('zh-CN')}`, ''];
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## 我', '');
      lines.push(message.content.trim(), '');
      for (const image of message.images ?? []) lines.push(`![图片](${image})`, '');
      continue;
    }
    lines.push('## LockAI', '');
    const body = stripToolMarkers(message.content);
    if (body) lines.push(body, '');
    for (const trace of message.tool_trace ?? []) {
      if (trace.kind === 'image_gen' && trace.url) {
        lines.push(`![${trace.prompt.replace(/[\[\]]/g, '')}](${trace.url})`, '');
      }
      if (trace.kind === 'search' && trace.sources?.length) {
        lines.push('来源：', ...trace.sources.map((s, i) => `${i + 1}. [${s.title || s.site}](${s.url})`), '');
      }
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function safeFilename(title: string): string {
  return (title || 'LockAI 对话').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'LockAI 对话';
}
