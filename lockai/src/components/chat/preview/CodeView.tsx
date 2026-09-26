'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Braces, Check, Copy, WrapText } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { BarButton, Dot, formatCount, humanSize, ViewerBar } from './shared';

/** 超过这么大就不做语法高亮（高亮很慢），只保留行号 */
const HIGHLIGHT_LIMIT = 200 * 1024;

const LANGUAGE_NAMES: Record<string, string> = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'JSX', tsx: 'TSX', json: 'JSON', json5: 'JSON5',
  yaml: 'YAML', toml: 'TOML', ini: '配置', bash: 'Shell', powershell: 'PowerShell', batch: 'Batch', sql: 'SQL', markup: 'XML',
  css: 'CSS', scss: 'SCSS', latex: 'LaTeX', r: 'R', go: 'Go', rust: 'Rust', c: 'C', cpp: 'C++', java: 'Java', kotlin: 'Kotlin',
  swift: 'Swift', csharp: 'C#', php: 'PHP', ruby: 'Ruby', lua: 'Lua', matlab: 'MATLAB', julia: 'Julia', docker: 'Dockerfile',
  makefile: 'Makefile', diff: '差异', mermaid: 'Mermaid', dot: 'Graphviz', log: '日志', markdown: 'Markdown', gcode: 'G-code',
  typst: 'Typst', text: '纯文本',
};

interface CodeViewProps {
  code: string;
  language: string;
  /** 文件字节数（显示用） */
  size?: number;
  truncated?: boolean;
  /** 工具栏上的类型名（默认按语言） */
  label?: string;
  /** 工具栏最左边额外的操作（比如"预览 / 源码"切换） */
  actions?: ReactNode;
}

function prettyJson(code: string): string | null {
  try {
    return JSON.stringify(JSON.parse(code), null, 2);
  } catch {
    // JSON Lines：一行一个对象
    const lines = code.split('\n').filter((l) => l.trim());
    if (lines.length < 2) return null;
    try {
      return lines.map((l) => JSON.stringify(JSON.parse(l), null, 2)).join('\n\n');
    } catch {
      return null;
    }
  }
}

/** 代码 / 文本：行号、语法高亮、自动换行、复制；JSON 可以一键格式化 */
export function CodeView({ code, language, size, truncated, label, actions }: CodeViewProps) {
  const { resolvedTheme } = useTheme();
  const [wrap, setWrap] = useState(language === 'text' || language === 'log' || language === 'markdown');
  const [copied, setCopied] = useState(false);
  const isJson = language === 'json' || language === 'json5';
  const pretty = useMemo(() => (isJson && !truncated ? prettyJson(code) : null), [code, isJson, truncated]);
  // 压成一行的 JSON 默认就展开
  const [formatted, setFormatted] = useState(() => Boolean(pretty) && code.split('\n').length < 3);
  const shown = formatted && pretty ? pretty : code;
  const lines = useMemo(() => shown.split('\n').length, [shown]);
  const highlight = shown.length <= HIGHLIGHT_LIMIT && language !== 'text';

  const copy = async () => {
    if (await copyText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="flex h-full flex-col bg-(--code-bg)">
      <ViewerBar
        actions={
          <>
            {actions}
            {pretty && (
              <BarButton label={formatted ? '显示原文' : '格式化'} active={formatted} onClick={() => setFormatted((v) => !v)}>
                <Braces className="h-3.5 w-3.5" />
              </BarButton>
            )}
            <BarButton label={wrap ? '取消换行' : '自动换行'} active={wrap} onClick={() => setWrap((v) => !v)}>
              <WrapText className="h-3.5 w-3.5" />
            </BarButton>
            <BarButton label="复制全部" onClick={() => void copy()}>
              {copied ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
            </BarButton>
          </>
        }
      >
        <span className="font-medium text-fg-soft">{label ?? LANGUAGE_NAMES[language] ?? language}</span>
        <Dot />
        <span className="tabular-nums">{formatCount(lines)} 行</span>
        {size ? (<><Dot /><span>{humanSize(size)}</span></>) : null}
        {truncated && (<><Dot /><span>文件较大，只显示开头</span></>)}
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-auto">
        {highlight ? (
          <SyntaxHighlighter
            language={language}
            style={resolvedTheme === 'dark' ? oneDark : oneLight}
            showLineNumbers
            wrapLongLines={wrap}
            lineNumberStyle={{ color: 'var(--fg-faint)', opacity: 0.55, minWidth: '3.2em', paddingRight: '1.2em', userSelect: 'none' }}
            customStyle={{ margin: 0, padding: '12px 16px 24px 4px', background: 'transparent', fontSize: '12.5px', lineHeight: 1.7, overflow: 'visible' }}
            codeTagProps={{ style: { fontFamily: 'var(--font-mono)', background: 'transparent' } }}
          >
            {shown}
          </SyntaxHighlighter>
        ) : (
          <PlainLines text={shown} wrap={wrap} />
        )}
      </div>
    </div>
  );
}

/** 不高亮的大文件：行号 + 原文，一行一个块，浏览器照样流畅 */
function PlainLines({ text, wrap }: { text: string; wrap: boolean }) {
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <div className="py-3 pb-6 font-mono text-[12.5px] leading-[1.7] text-fg">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-[4.4em] shrink-0 select-none pr-[1.2em] text-right text-fg-faint/60 tabular-nums">{i + 1}</span>
          <span className={cn('min-w-0 pr-4', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>{line || ' '}</span>
        </div>
      ))}
    </div>
  );
}
