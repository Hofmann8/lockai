'use client';

import { memo, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Element, ElementContent, Root } from 'hast';
import type { PluggableList } from 'unified';
import { Check, Copy, Download, WrapText } from 'lucide-react';
import 'katex/dist/katex.min.css';

import { fixEmphasisFlanking, fixIncompleteMarkdown, normalizeLatexDelimiters } from '@/lib/markdown';
import { copyText, downloadFile, tableToCsv, tableToMarkdown } from '@/lib/clipboard';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { toast } from '@/components/ui/Toast';

/* ------------------------------------------------------------------ */
/* 流式输出时的逐词淡入：只包最后一段新文字，老段落保持纯文本节点，DOM 不膨胀 */
/* ------------------------------------------------------------------ */

const FADE_WINDOW = 600;
const SKIP_TAGS = new Set(['pre', 'code', 'svg', 'math', 'annotation', 'script', 'style']);

let segmenter: Intl.Segmenter | null = null;
function segmentWords(value: string): string[] {
  if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) return value.split(/(?<=\s)/);
  segmenter ??= new Intl.Segmenter('zh', { granularity: 'word' });
  const out: string[] = [];
  for (const { segment } of segmenter.segment(value)) {
    // 空白并到前一个词上，少造几个 span
    if (!segment.trim() && out.length > 0) out[out.length - 1] += segment;
    else out.push(segment);
  }
  return out;
}

function isSkipped(node: Element): boolean {
  if (SKIP_TAGS.has(node.tagName)) return true;
  const className = node.properties?.className;
  return Array.isArray(className) && className.some((c) => String(c).startsWith('katex'));
}

function rehypeStreamFade(options: { from: number }) {
  const { from } = options;
  const walk = (parent: Root | Element) => {
    const next: ElementContent[] = [];
    let changed = false;
    for (const child of parent.children as ElementContent[]) {
      if (child.type === 'element') {
        if (!isSkipped(child)) walk(child);
        next.push(child);
        continue;
      }
      const end = child.position?.end?.offset ?? Number.POSITIVE_INFINITY;
      if (child.type !== 'text' || end < from || !child.value.trim()) {
        next.push(child);
        continue;
      }
      changed = true;
      for (const word of segmentWords(child.value)) {
        next.push({ type: 'element', tagName: 'span', properties: { className: ['sw'] }, children: [{ type: 'text', value: word }] });
      }
    }
    if (changed) parent.children = next as typeof parent.children;
  };
  return (tree: Root) => walk(tree);
}

/* ------------------------------------------------------------------ */
/* 代码块 */
/* ------------------------------------------------------------------ */

function CodeBlock({ language, code, streaming }: { language: string; code: string; streaming: boolean }) {
  const { resolvedTheme } = useTheme();
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const lines = code.split('\n').length;

  const handleCopy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };

  const baseStyle = resolvedTheme === 'dark' ? oneDark : oneLight;

  return (
    <div className="group/code my-4 overflow-hidden rounded-2xl border border-line bg-(--code-bg)">
      <div data-copy-skip className="flex h-9 items-center justify-between border-b border-line pl-4 pr-1.5 text-xs text-fg-faint">
        <span className="font-mono tracking-tight">{language || 'text'}</span>
        <div className="flex items-center gap-0.5">
          {lines > 1 && (
            <button
              type="button"
              onClick={() => setWrap((v) => !v)}
              aria-pressed={wrap}
              title={wrap ? '取消换行' : '自动换行'}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 hover:text-fg',
                wrap && 'text-fg',
              )}
            >
              <WrapText className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 transition-colors hover:bg-surface-2 hover:text-fg"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
      {streaming ? (
        <pre className={cn('overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-relaxed text-fg', wrap && 'whitespace-pre-wrap break-words')}>
          <code>{code}</code>
        </pre>
      ) : (
        <SyntaxHighlighter
          language={language || 'text'}
          style={baseStyle}
          wrapLongLines={wrap}
          showLineNumbers={lines > 4}
          lineNumberStyle={{ color: 'var(--fg-faint)', opacity: 0.6, minWidth: '2.2em' }}
          customStyle={{ margin: 0, padding: '14px 16px', background: 'transparent', fontSize: '13px', lineHeight: 1.65 }}
          codeTagProps={{ style: { fontFamily: 'var(--font-mono)', background: 'transparent' } }}
        >
          {code}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 表格：悬停出现"复制为 Markdown / 下载 CSV" */
/* ------------------------------------------------------------------ */

const BOM = String.fromCharCode(0xfeff);

function TableBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const copyMd = async () => {
    if (ref.current && (await copyText(tableToMarkdown(ref.current)))) toast('表格已复制为 Markdown');
  };
  const saveCsv = () => {
    if (!ref.current) return;
    // 带 BOM，Excel 打开中文不乱码
    downloadFile(`LockAI 表格 ${new Date().toLocaleDateString('zh-CN').replace(/\//g, '-')}.csv`, BOM + tableToCsv(ref.current), 'text/csv;charset=utf-8');
  };
  return (
    <div className="group/table relative my-4">
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table ref={ref}>{children}</table>
      </div>
      <div data-copy-skip className="absolute -top-3 right-2 flex gap-0.5 rounded-xl border border-line bg-surface p-0.5 opacity-0 shadow-soft transition-opacity group-hover/table:opacity-100 focus-within:opacity-100">
        <button type="button" onClick={copyMd} className="flex h-6 items-center gap-1 rounded-lg px-2 text-[11.5px] text-fg-soft hover:bg-surface-2 hover:text-fg">
          <Copy className="h-3 w-3" /> Markdown
        </button>
        <button type="button" onClick={saveCsv} className="flex h-6 items-center gap-1 rounded-lg px-2 text-[11.5px] text-fg-soft hover:bg-surface-2 hover:text-fg">
          <Download className="h-3 w-3" /> CSV
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface MarkdownProps {
  content: string;
  streaming?: boolean;
  /** 工具卡片里已经展示过的图片，正文里不再重复 */
  hiddenImageUrls?: string[];
  className?: string;
  /** 用户消息：不做流式修补，排版更紧凑 */
  compact?: boolean;
}

function MarkdownImpl({ content, streaming = false, hiddenImageUrls, className, compact = false }: MarkdownProps) {
  const source = useMemo(
    () => (compact ? content : fixEmphasisFlanking(fixIncompleteMarkdown(normalizeLatexDelimiters(content)))),
    [compact, content],
  );
  const hidden = useMemo(() => new Set(hiddenImageUrls ?? []), [hiddenImageUrls]);

  const rehypePlugins = useMemo<PluggableList>(
    () => (streaming
      ? [rehypeRaw, rehypeKatex, [rehypeStreamFade, { from: Math.max(0, source.length - FADE_WINDOW) }]]
      : [rehypeRaw, rehypeKatex]),
    [source.length, streaming],
  );

  const components = useMemo<Components>(() => ({
    code: ({ className: codeClass, children }) => {
      const match = /language-([\w+#-]+)/.exec(codeClass || '');
      const text = String(children ?? '');
      const isBlock = Boolean(match) || text.includes('\n');
      if (!isBlock) return <code>{children}</code>;
      return <CodeBlock language={match?.[1] ?? ''} code={text.replace(/\n$/, '')} streaming={streaming} />;
    },
    pre: ({ children }) => <>{children}</>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    ),
    table: ({ children }) => <TableBlock>{children}</TableBlock>,
    img: ({ src, alt }) => {
      const url = typeof src === 'string' ? src : '';
      if (!url || hidden.has(url)) return null;
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={url} alt={alt || '图片'} loading="lazy" />;
    },
  }), [hidden, streaming]);

  return (
    <div className={cn('md', compact && 'md-compact', className)}>
      <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
