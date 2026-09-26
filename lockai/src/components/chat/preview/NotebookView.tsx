'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Code2, EyeOff } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { Markdown } from '../Markdown';
import { BarButton, Dot, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';

type Multiline = string | string[];

interface Output {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: Multiline;
  data?: Record<string, Multiline>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface Cell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: Multiline;
  execution_count?: number | null;
  outputs?: Output[];
}

interface Notebook {
  cells: Cell[];
  metadata?: { kernelspec?: { display_name?: string; language?: string }; language_info?: { name?: string } };
}

const join = (v: Multiline | undefined) => (Array.isArray(v) ? v.join('') : v ?? '');
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

/** 输出里的 HTML（pandas 表格之类）：放进隔离的 iframe，高度随内容 */
function HtmlOutput({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const doc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font:12.5px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#2b2622;background:transparent}
    table{border-collapse:collapse;font-variant-numeric:tabular-nums}
    th,td{border-bottom:1px solid #e7e2da;padding:4px 10px;text-align:right;white-space:nowrap}
    thead th{border-bottom:1px solid #cfc8bd;font-weight:600}
    tbody tr:hover{background:#f6f3ee}
    img{max-width:100%}
  </style></head><body>${html}<script>
    const post=()=>parent.postMessage({nbHeight:document.documentElement.scrollHeight,id:${JSON.stringify(html.length)}},'*');
    new ResizeObserver(post).observe(document.body);post();
  </script></body></html>`, [html]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source === ref.current?.contentWindow && typeof e.data?.nbHeight === 'number') setHeight(Math.min(900, e.data.nbHeight + 4));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return <iframe ref={ref} srcDoc={doc} sandbox="allow-scripts" title="输出" style={{ height }} className="w-full rounded-lg bg-white" />;
}

function OutputView({ output }: { output: Output }) {
  if (output.output_type === 'stream') {
    return (
      <pre className={cn('overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed', output.name === 'stderr' ? 'text-danger' : 'text-fg-soft')}>
        {stripAnsi(join(output.text))}
      </pre>
    );
  }
  if (output.output_type === 'error') {
    return (
      <pre className="overflow-x-auto rounded-lg bg-danger-soft px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-danger">
        {stripAnsi((output.traceback ?? [`${output.ename}: ${output.evalue}`]).join('\n'))}
      </pre>
    );
  }
  const data = output.data ?? {};
  for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    // eslint-disable-next-line @next/next/no-img-element
    if (data[mime]) return <img alt="输出图像" src={`data:${mime};base64,${join(data[mime]).replace(/\s/g, '')}`} className="max-w-full rounded-lg bg-white" />;
  }
  if (data['image/svg+xml']) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img alt="输出图像" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(join(data['image/svg+xml']))}`} className="max-w-full rounded-lg bg-white" />;
  }
  if (data['text/html']) return <HtmlOutput html={join(data['text/html'])} />;
  if (data['text/markdown']) return <Markdown content={join(data['text/markdown'])} />;
  if (data['text/latex']) return <Markdown content={join(data['text/latex'])} />;
  if (data['text/plain']) {
    return <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg-soft">{join(data['text/plain'])}</pre>;
  }
  return <p className="text-[12px] text-fg-faint">（这种输出没法在网页里显示：{Object.keys(data).join(', ') || output.output_type}）</p>;
}

/** Jupyter 笔记本：Markdown 单元排版、代码高亮、输出（文字 / 图 / 表格 / 报错）照原样显示 */
export default function NotebookView({ file }: { file: FileArtifact }) {
  const { resolvedTheme } = useTheme();
  const { text, error } = useFetched(file.url, 'text', 30 * 1024 * 1024);
  const [hideCode, setHideCode] = useState(false);
  const notebook = useMemo<Notebook | null>(() => {
    if (text === undefined) return null;
    try {
      return JSON.parse(text) as Notebook;
    } catch {
      return { cells: [] };
    }
  }, [text]);

  if (error) return <PreviewFallback file={file} note="笔记本没能加载出来，可以下载后用 Jupyter 打开" />;
  if (!notebook) return <Opening />;
  if (!notebook.cells?.length) return <PreviewFallback file={file} note="没能读出笔记本的内容（可能不是有效的 .ipynb）" />;

  const language = notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? 'python';
  const codeCells = notebook.cells.filter((c) => c.cell_type === 'code').length;
  const style = resolvedTheme === 'dark' ? oneDark : oneLight;

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <BarButton label={hideCode ? '显示代码' : '只看结果'} active={hideCode} onClick={() => setHideCode((v) => !v)}>
            {hideCode ? <EyeOff className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
          </BarButton>
        }
      >
        <span className="font-medium text-fg-soft">{notebook.metadata?.kernelspec?.display_name ?? 'Jupyter'}</span>
        <Dot />
        <span className="tabular-nums">{notebook.cells.length} 个单元 · {codeCells} 段代码</span>
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
        <div className="mx-auto max-w-[860px] px-4 py-5 sm:px-6">
          {notebook.cells.map((cell, i) => {
            const source = join(cell.source);
            if (cell.cell_type === 'markdown') {
              return (
                <div key={i} className="py-2 pl-[3.25rem] text-[14px]">
                  <Markdown content={source} />
                </div>
              );
            }
            if (cell.cell_type === 'raw') {
              return <pre key={i} className="my-2 ml-[3.25rem] whitespace-pre-wrap font-mono text-[12px] text-fg-faint">{source}</pre>;
            }
            const outputs = cell.outputs ?? [];
            if (hideCode && outputs.length === 0) return null;
            return (
              <div key={i} className="group/cell my-3">
                {!hideCode && (
                  <div className="flex gap-2">
                    <span className="w-11 shrink-0 pt-2.5 text-right font-mono text-[11px] text-fg-faint tabular-nums">[{cell.execution_count ?? ' '}]</span>
                    <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-(--code-bg) transition-colors group-hover/cell:border-line-strong">
                      <SyntaxHighlighter
                        language={language}
                        style={style}
                        customStyle={{ margin: 0, padding: '10px 14px', background: 'transparent', fontSize: '12.5px', lineHeight: 1.6 }}
                        codeTagProps={{ style: { fontFamily: 'var(--font-mono)', background: 'transparent' } }}
                      >
                        {source}
                      </SyntaxHighlighter>
                    </div>
                  </div>
                )}
                {outputs.length > 0 && (
                  <div className="mt-1.5 flex gap-2">
                    <span className="w-11 shrink-0" />
                    <div className="min-w-0 flex-1 space-y-2 overflow-x-auto px-1 py-1">
                      {outputs.map((o, j) => <OutputView key={j} output={o} />)}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
