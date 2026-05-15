'use client';

import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import { User, Copy, Check, Undo2, X, Loader2, Maximize2, Download } from 'lucide-react';
import Image from 'next/image';
import { useTheme } from '@/lib/theme';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'katex/dist/katex.min.css';

import { fixIncompleteMarkdown, fixEmphasisFlanking, normalizeLatexDelimiters } from '@/lib/markdown';
import type { ChatMessage, ToolTrace } from '@/types';

interface MessageProps {
  message: ChatMessage;
  contentOverride?: string;
  onRecall?: (message: ChatMessage) => void;
  isStreaming?: boolean;
  waitingSeconds?: number;
  searchSeconds?: number;
  imageGenSeconds?: number;
  toolFollowupSeconds?: number;
  thinkingEnabled?: boolean;
}

function AssistantAvatar({
  resolvedTheme,
  spinning = false,
}: {
  resolvedTheme: string | undefined;
  spinning?: boolean;
}) {
  return (
    <div className="relative flex h-10 w-10 items-center justify-center">
      {spinning && <span className="assistant-avatar-pulse" aria-hidden="true" />}
      {spinning && <span className="assistant-avatar-spinner" aria-hidden="true" />}
      <div className="relative h-6 w-6">
        <Image
          src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
          alt="LockAI"
          width={24}
          height={24}
          className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
        />
        <Image
          src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
          alt="LockAI"
          width={24}
          height={24}
          className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'light' ? 'opacity-100' : 'opacity-0'}`}
        />
      </div>
    </div>
  );
}

function CodeBlock({ language, children, isUser }: { language: string; children: string; isUser: boolean }) {
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-3 group">
      <div className={`flex items-center justify-between text-xs px-3 py-1.5 rounded-t-lg ${isUser ? 'bg-primary-foreground/10' : 'bg-muted/80 border border-border border-b-0'}`}>
        <span className="text-muted-foreground">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={resolvedTheme === 'dark' ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
          borderBottomLeftRadius: '0.75rem',
          borderBottomRightRadius: '0.75rem',
          fontSize: '0.875rem',
        }}
        showLineNumbers={children.split('\n').length > 3}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
}

function MarkdownBlock({
  content,
  isUser,
  showCursor = false,
   hiddenImageUrls,
}: {
  content: string;
  isUser: boolean;
  showCursor?: boolean;
  hiddenImageUrls?: string[];
}) {
  const source = isUser ? content : fixEmphasisFlanking(fixIncompleteMarkdown(normalizeLatexDelimiters(content)));
  const hiddenImageSet = useMemo(() => new Set(hiddenImageUrls ?? []), [hiddenImageUrls]);

  return (
    <div className={`prose prose-sm max-w-none ${isUser ? 'prose-invert' : 'dark:prose-invert'}`} style={{ overflowWrap: 'anywhere' }}>
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={{
          h1: ({ children }) => <h1 className="text-2xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="text-base font-semibold mb-2 mt-2 first:mt-0">{children}</h4>,
          h5: ({ children }) => <h5 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h5>,
          h6: ({ children }) => <h6 className="text-sm font-medium mb-1 mt-2 first:mt-0">{children}</h6>,
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
          blockquote: ({ children }) => (
            <blockquote className={`border-l-4 pl-3 my-2 italic ${isUser ? 'border-primary-foreground/50' : 'border-primary/40 text-muted-foreground'}`}>
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !className;

            if (isInline) {
              return (
                <code className={`px-1.5 py-0.5 rounded text-sm font-mono ${isUser ? 'bg-primary-foreground/20' : 'bg-muted border border-border/70'}`}>
                  {children}
                </code>
              );
            }

            return (
              <CodeBlock language={match?.[1] || ''} isUser={isUser}>
                {String(children).replace(/\n$/, '')}
              </CodeBlock>
            );
          },
          pre: ({ children }) => <>{children}</>,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="mb-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline hover:no-underline ${isUser ? '' : 'text-primary'}`}
            >
              {children}
            </a>
          ),
          hr: () => <hr className={`my-4 border-t ${isUser ? 'border-primary-foreground/30' : 'border-border'}`} />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 rounded-lg border border-border">
              <table className="min-w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className={`${isUser ? 'bg-primary-foreground/10' : 'bg-muted'}`}>{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className={`border-b last:border-b-0 ${isUser ? 'border-primary-foreground/20' : 'border-border'}`}>{children}</tr>,
          th: ({ children, style }) => <th className="px-3 py-2 font-semibold" style={style}>{children}</th>,
          td: ({ children, style }) => <td className="px-3 py-2" style={style}>{children}</td>,
          img: ({ src, alt }) => {
            const imageSrc = typeof src === 'string' ? src : '';
            if (!imageSrc || hiddenImageSet.has(imageSrc)) {
              return null;
            }
            return (
              <img
                src={imageSrc}
                alt={alt || '图片'}
                className="rounded-lg max-w-full h-auto my-2"
              />
            );
          },
          sup: ({ children }) => <sup className="text-xs">{children}</sup>,
          sub: ({ children }) => <sub className="text-xs">{children}</sub>,
          kbd: ({ children }) => (
            <kbd className={`px-1.5 py-0.5 rounded text-xs font-mono ${isUser ? 'bg-primary-foreground/20' : 'bg-muted border border-border shadow-sm'}`}>
              {children}
            </kbd>
          ),
          details: ({ children }) => (
            <details className={`my-2 rounded-lg border p-3 open:pb-3 ${isUser ? 'border-primary-foreground/20' : 'border-border'}`}>
              {children}
            </details>
          ),
          summary: ({ children }) => (
            <summary className="cursor-pointer font-medium select-none">{children}</summary>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
      {showCursor && (
        <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
      )}
    </div>
  );
}

function SearchToolCard({
  trace,
  seconds = 0,
  followupLabel,
}: {
  trace: Extract<ToolTrace, { kind: 'search' }>;
  seconds?: number;
  followupLabel?: string;
}) {
  const running = trace.status === 'running';
  const statusText = followupLabel || (running ? '正在联网搜索' : trace.success ? '搜索完成' : '搜索失败');
  const keywords = trace.query
    ? trace.query
        .split(/[\s,，、；;：:。!?！？()（）【】\[\]<>《》"'`]+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  return (
    <div className="rounded-2xl border border-border bg-muted/40 px-4 py-3 my-3 animate-fade-in-up transition-all duration-300">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {running ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <Check className={`w-4 h-4 ${trace.success ? 'text-primary' : 'text-destructive'}`} />}
        <span>{statusText}</span>
        {seconds > 0 && <span className="text-xs text-muted-foreground tabular-nums">{seconds}s</span>}
      </div>
      {keywords.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
          {keywords.map((token, index) => (
            <ImageMetaChip
              key={`${token}-${index}`}
              label="关键词"
              value={token}
              className="max-w-[8.5rem] shrink-0"
              valueClassName="max-w-[5rem] truncate"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ImageMetaChip({
  label,
  value,
  accent = false,
  className = '',
  valueClassName = '',
}: {
  label: string;
  value: string;
  accent?: boolean;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${accent ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border/70 bg-background/70 text-muted-foreground'} ${className}`.trim()}>
      <span className="uppercase tracking-[0.12em]">{label}</span>
      <span className={`${accent ? 'text-primary' : 'text-foreground'} ${valueClassName}`.trim()}>{value}</span>
    </div>
  );
}

function ImageRequestSection({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ label: string; value: string }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 first:mt-0">
      <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{title}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={`${title}-${row.label}`} className="rounded-xl border border-border/70 bg-background/70 px-3 py-2.5">
            <div className="text-[11px] text-muted-foreground">{row.label}</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function formatAspectRatioFromDimensions(width?: number, height?: number): string {
  if (!width || !height || width <= 0 || height <= 0) return '';
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function resolveAspectRatioLabel(trace: Extract<ToolTrace, { kind: 'image_gen' }>): string {
  return pickFirstNonEmpty(
    trace.outputAspectRatio,
    trace.resolvedEditRequest?.imageConfig?.aspectRatio,
    trace.editRequest?.imageConfig?.aspectRatio,
    trace.request?.imageConfig?.aspectRatio,
    formatAspectRatioFromDimensions(trace.outputWidth, trace.outputHeight),
  );
}

function resolveImageSizeLabel(trace: Extract<ToolTrace, { kind: 'image_gen' }>): string {
  return pickFirstNonEmpty(
    trace.resolvedEditRequest?.imageConfig?.imageSize,
    trace.editRequest?.imageConfig?.imageSize,
    trace.request?.imageConfig?.imageSize,
  );
}

function resolveAspectRatioStyle(label: string): CSSProperties | undefined {
  const cleaned = label.trim();
  if (!cleaned || !cleaned.includes(':')) {
    return undefined;
  }
  return { aspectRatio: cleaned.replace(':', ' / ') };
}

function ToolImagePreview({
  url,
  blurredUrl,
  alt,
  shouldBlur,
  aspectRatioStyle,
  placeholderLabel,
}: {
  url?: string;
  blurredUrl?: string;
  alt: string;
  shouldBlur: boolean;
  aspectRatioStyle?: CSSProperties;
  placeholderLabel: string;
}) {
  const effectiveUrl = shouldBlur && blurredUrl ? blurredUrl : url;
  const [loaded, setLoaded] = useState(false);
  const [measuredAspectRatioStyle, setMeasuredAspectRatioStyle] = useState<CSSProperties | undefined>(aspectRatioStyle);
  const aspectRatioKey = aspectRatioStyle?.aspectRatio ? String(aspectRatioStyle.aspectRatio) : '';

  useEffect(() => {
    setLoaded(false);
    setMeasuredAspectRatioStyle(aspectRatioKey ? { aspectRatio: aspectRatioKey } : undefined);
  }, [aspectRatioKey, effectiveUrl]);

  const handleLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!aspectRatioKey && event.currentTarget.naturalWidth > 0 && event.currentTarget.naturalHeight > 0) {
      setMeasuredAspectRatioStyle({ aspectRatio: `${event.currentTarget.naturalWidth} / ${event.currentTarget.naturalHeight}` });
    }
    setLoaded(true);
  }, [aspectRatioKey]);

  const attachImageRef = useCallback((node: HTMLImageElement | null) => {
    if (!node) return;
    if (node.complete && node.naturalWidth > 0) {
      setLoaded(true);
      if (!aspectRatioKey) {
        setMeasuredAspectRatioStyle({ aspectRatio: `${node.naturalWidth} / ${node.naturalHeight}` });
      }
    }
  }, [aspectRatioKey]);

  const frameStyle = measuredAspectRatioStyle;
  const hasLockedRatio = Boolean(frameStyle?.aspectRatio);
  const imageClassName = hasLockedRatio
    ? `absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ease-out ${loaded ? 'opacity-100' : 'opacity-0'}`
    : `block h-auto max-h-[420px] w-full object-contain transition-opacity duration-700 ease-out ${loaded ? 'opacity-100' : 'opacity-0'}`;

  const [previewOpen, setPreviewOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const canInteract = Boolean(effectiveUrl) && loaded && !shouldBlur;

  const handleDownload = useCallback(async () => {
    if (!effectiveUrl || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(effectiveUrl, { mode: 'cors' });
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const ext = (blob.type.split('/')[1] || 'png').split(';')[0];
      a.download = `lockai-${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(effectiveUrl, '_blank');
    } finally {
      setDownloading(false);
    }
  }, [effectiveUrl, downloading]);

  return (
    <>
      <div className="group relative mt-3 w-full max-w-[420px] overflow-hidden rounded-2xl border border-border/70 bg-background/60">
        <div className={`relative w-full ${hasLockedRatio ? '' : 'min-h-[220px]'}`} style={frameStyle}>
          {effectiveUrl ? (
            <>
              <img
                ref={attachImageRef}
                src={effectiveUrl}
                alt={alt}
                onLoad={handleLoad}
                className={imageClassName}
              />
              {(!loaded || shouldBlur) && (
                <div className="absolute inset-0 overflow-hidden bg-muted/70">
                  <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/15 to-transparent animate-[shimmer_2s_ease-in-out_infinite]" style={{ backgroundSize: '200% 100%' }} />
                </div>
              )}
              {shouldBlur && (
                <div className="absolute inset-x-3 bottom-3 rounded-xl bg-black/45 px-3 py-2 text-xs text-white backdrop-blur-sm">
                  {placeholderLabel}
                </div>
              )}
              {canInteract && (
                <div className="pointer-events-none absolute inset-0 flex items-end justify-end gap-2 bg-linear-to-t from-black/45 via-black/0 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(true)}
                    title="放大预览"
                    className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/75 cursor-pointer"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={downloading}
                    title="下载（含水印）"
                    className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/75 disabled:opacity-60 cursor-pointer"
                  >
                    {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="absolute inset-0 overflow-hidden bg-muted/70">
              <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/15 to-transparent animate-[shimmer_2s_ease-in-out_infinite]" style={{ backgroundSize: '200% 100%' }} />
              <div className="absolute inset-x-3 bottom-3 rounded-xl bg-background/80 px-3 py-2 text-xs text-muted-foreground">
                {placeholderLabel}
              </div>
            </div>
          )}
        </div>
      </div>
      {previewOpen && effectiveUrl && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6 animate-fade-in"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="relative flex max-h-[90vh] max-w-[min(960px,92vw)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">图片预览</div>
                <div className="truncate text-[11px] text-muted-foreground">{alt || '生成图片'}</div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={downloading}
                  title="下载（含水印）"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-60 cursor-pointer"
                >
                  {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewOpen(false)}
                  title="关闭"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-3">
              <img
                src={effectiveUrl}
                alt={alt}
                className="max-h-full max-w-full rounded-lg object-contain"
              />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function ImageToolCard({
  trace,
  seconds = 0,
  followupLabel,
  settling = false,
}: {
  trace: Extract<ToolTrace, { kind: 'image_gen' }>;
  seconds?: number;
  followupLabel?: string;
  settling?: boolean;
}) {
  const running = trace.status === 'running';
  const title = followupLabel
    || (trace.mode === 'edit'
      ? (running ? '正在编辑图片' : trace.success ? '图片编辑完成' : '图片编辑失败')
      : (running ? '正在生成图片' : trace.success ? '图片生成完成' : '图片生成失败'));
  const [showDetails, setShowDetails] = useState(false);
  const isEdit = trace.mode === 'edit';
  const subject = isEdit
    ? trace.editRequest?.instruction?.trim() || trace.prompt
    : trace.request?.subject?.trim() || trace.prompt;
  const aspectRatioLabel = resolveAspectRatioLabel(trace);
  const imageSizeLabel = resolveImageSizeLabel(trace);
  const aspectRatioStyle = useMemo(() => (
    typeof trace.outputWidth === 'number'
    && trace.outputWidth > 0
    && typeof trace.outputHeight === 'number'
    && trace.outputHeight > 0
      ? { aspectRatio: `${trace.outputWidth} / ${trace.outputHeight}` }
      : resolveAspectRatioStyle(aspectRatioLabel)
  ), [aspectRatioLabel, trace.outputHeight, trace.outputWidth]);
  const outputSizeLabel = (
    typeof trace.outputWidth === 'number'
    && trace.outputWidth > 0
    && typeof trace.outputHeight === 'number'
    && trace.outputHeight > 0
  )
    ? `${trace.outputWidth} × ${trace.outputHeight}`
    : '';
  const summaryChips = (
    isEdit
      ? [
          trace.sourceImageId ? { label: '源图', value: '已锁定' } : null,
          aspectRatioLabel ? { label: '比例', value: aspectRatioLabel, accent: true } : null,
          imageSizeLabel ? { label: '清晰度', value: imageSizeLabel, accent: true } : null,
          outputSizeLabel ? { label: '输出', value: outputSizeLabel } : null,
          trace.editRequest?.preserve?.trim() ? { label: '保留', value: '已指定' } : null,
          trace.editRequest?.negativePrompt?.trim() ? { label: '约束', value: '已指定' } : null,
        ]
      : [
          aspectRatioLabel ? { label: '比例', value: aspectRatioLabel, accent: true } : null,
          imageSizeLabel ? { label: '清晰度', value: imageSizeLabel, accent: true } : null,
          outputSizeLabel ? { label: '输出', value: outputSizeLabel } : null,
          trace.request?.style?.trim() ? { label: '风格', value: trace.request.style.trim() } : null,
          trace.request?.composition?.trim() ? { label: '构图', value: trace.request.composition.trim() } : null,
          trace.request?.lighting?.trim() ? { label: '光线', value: trace.request.lighting.trim() } : null,
        ]
  ).filter((item): item is { label: string; value: string; accent?: boolean } => Boolean(item));

  const coreRows = (
    isEdit
      ? [
          subject ? { label: '编辑要求', value: subject } : null,
          trace.sourceLabel ? { label: '源图说明', value: trace.sourceLabel } : null,
          trace.sourceImageId ? { label: '源图 ID', value: trace.sourceImageId } : null,
          trace.editRequest?.sourceHint?.trim() ? { label: '找图提示', value: trace.editRequest.sourceHint.trim() } : null,
          typeof trace.editRequest?.sourceIndex === 'number' ? { label: '图片序号', value: String(trace.editRequest.sourceIndex) } : null,
          trace.editRequest?.preserve?.trim() ? { label: '保留内容', value: trace.editRequest.preserve.trim() } : null,
        ]
      : [
          subject ? { label: '主体', value: subject } : null,
          trace.request?.details?.trim() ? { label: '细节', value: trace.request.details.trim() } : null,
          trace.request?.background?.trim() ? { label: '背景', value: trace.request.background.trim() } : null,
          trace.request?.textOverlay?.trim() ? { label: '图中文字', value: trace.request.textOverlay.trim() } : null,
        ]
  ).filter((row): row is { label: string; value: string } => Boolean(row));

  const visualRows = (
    isEdit
      ? [
          aspectRatioLabel ? { label: '宽高比', value: aspectRatioLabel } : null,
          imageSizeLabel ? { label: '分辨率', value: imageSizeLabel } : null,
          typeof trace.outputWidth === 'number' && typeof trace.outputHeight === 'number'
            ? { label: '实际画布', value: `${trace.outputWidth} × ${trace.outputHeight}` }
            : null,
        ]
      : [
          trace.request?.style?.trim() ? { label: '风格', value: trace.request.style.trim() } : null,
          trace.request?.composition?.trim() ? { label: '构图', value: trace.request.composition.trim() } : null,
          trace.request?.camera?.trim() ? { label: '镜头', value: trace.request.camera.trim() } : null,
          trace.request?.lighting?.trim() ? { label: '光线', value: trace.request.lighting.trim() } : null,
          trace.request?.colorTone?.trim() ? { label: '色调', value: trace.request.colorTone.trim() } : null,
          aspectRatioLabel ? { label: '宽高比', value: aspectRatioLabel } : null,
          imageSizeLabel ? { label: '分辨率', value: imageSizeLabel } : null,
          outputSizeLabel ? { label: '实际画布', value: outputSizeLabel } : null,
        ]
  ).filter((row): row is { label: string; value: string } => Boolean(row));

  const constraintRows = (
    isEdit
      ? [
          trace.editRequest?.negativePrompt?.trim() ? { label: '避免项', value: trace.editRequest.negativePrompt.trim() } : null,
        ]
      : [
          trace.request?.negativePrompt?.trim() ? { label: '避免项', value: trace.request.negativePrompt.trim() } : null,
        ]
  ).filter((row): row is { label: string; value: string } => Boolean(row));

  const placeholderLabel = running
    ? (isEdit ? '正在渲染编辑预览' : '正在渲染图片')
    : followupLabel
      || (trace.success ? '图片已经准备完成' : '正在整理本次绘图结果');

  return (
    <div className="rounded-2xl border border-border bg-muted/40 px-4 py-3 my-3 animate-fade-in-up transition-all duration-300">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {running ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <Check className={`w-4 h-4 ${trace.success ? 'text-primary' : 'text-destructive'}`} />}
        <span>{title}</span>
        {seconds > 0 && <span className="text-xs text-muted-foreground tabular-nums">{seconds}s</span>}
        {trace.modelLabel && (
          <span className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-primary/10 text-primary border border-primary/20">
            {trace.modelLabel}
          </span>
        )}
      </div>
      <div className="mt-2 pl-0.5">
        <div className="text-sm font-medium text-foreground line-clamp-2">{subject}</div>
        {summaryChips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summaryChips.map((chip) => (
              <ImageMetaChip key={`${chip.label}-${chip.value}`} label={chip.label} value={chip.value} accent={chip.accent} />
            ))}
          </div>
        )}
        {(coreRows.length > 0 || visualRows.length > 0 || constraintRows.length > 0) && (
          <button
            type="button"
            onClick={() => setShowDetails((value) => !value)}
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 cursor-pointer"
          >
            <span>{showDetails ? '收起参数' : '查看参数'}</span>
            <span className={`transition-transform duration-200 ${showDetails ? 'rotate-180' : ''}`}>⌄</span>
          </button>
        )}
        {showDetails && (
          <div className="mt-3">
            <ImageRequestSection title="主要内容" rows={coreRows} />
            <ImageRequestSection title="画面控制" rows={visualRows} />
            <ImageRequestSection title="约束条件" rows={constraintRows} />
          </div>
        )}
        <ToolImagePreview
          url={trace.url}
          blurredUrl={trace.blurredUrl}
          alt={subject || trace.prompt || '生成图片'}
          shouldBlur={Boolean(trace.url && settling)}
          aspectRatioStyle={aspectRatioStyle}
          placeholderLabel={placeholderLabel}
        />
      </div>
    </div>
  );
}

function MessageComponent({
  message,
  contentOverride,
  onRecall,
  isStreaming = false,
  waitingSeconds = 0,
  searchSeconds = 0,
  imageGenSeconds = 0,
  toolFollowupSeconds = 0,
  thinkingEnabled = true,
}: MessageProps) {
  const isUser = message.role === 'user';
  const renderedContent = contentOverride ?? message.content;
  const { resolvedTheme } = useTheme();
  const [copied, setCopied] = useState(false);
  const [showRecallConfirm, setShowRecallConfirm] = useState(false);
  const toolTrace = message.tool_trace ?? [];
  const hiddenToolImageUrls = useMemo(
    () => toolTrace
      .filter((trace): trace is Extract<ToolTrace, { kind: 'image_gen' }> => trace.kind === 'image_gen')
      .flatMap((trace) => [trace.url].filter((value): value is string => Boolean(value))),
    [toolTrace],
  );

  const handleCopyMessage = async () => {
    await navigator.clipboard.writeText(renderedContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const assistantParts = useMemo(() => {
    const parts: Array<{ type: 'text'; value: string } | { type: 'tool'; traceIdx: number }> = [];
    const content = renderedContent || '';
    const markerRe = /<!--tool:(\d+)-->/g;
    let lastIndex = 0;
    let matched = false;
    let match: RegExpExecArray | null = null;

    while ((match = markerRe.exec(content)) !== null) {
      matched = true;
      const segment = content.slice(lastIndex, match.index);
      if (segment.trim()) {
        parts.push({ type: 'text', value: segment });
      }
      parts.push({ type: 'tool', traceIdx: Number(match[1]) });
      lastIndex = match.index + match[0].length;
    }

    const tail = content.slice(lastIndex);
    if (tail.trim()) {
      parts.push({ type: 'text', value: tail });
    }

    if (!matched && toolTrace.length > 0) {
      if (content.trim()) {
        parts.push({ type: 'text', value: content });
      }
      toolTrace.forEach((_, index) => parts.push({ type: 'tool', traceIdx: index }));
    }

    return parts;
  }, [renderedContent, toolTrace]);

  const waitingMessage = thinkingEnabled ? '正在思考' : '正在组织回答';

  const isWaitingOnly = !isUser && isStreaming && !renderedContent.trim() && toolTrace.length === 0;
  const hasRunningTool = toolTrace.some((trace) => trace.status === 'running');
  const toolPartIndicesWithTextAfter = useMemo(() => {
    const indices = new Set<number>();
    let hasTextAfter = false;

    for (let index = assistantParts.length - 1; index >= 0; index -= 1) {
      const part = assistantParts[index];
      if (part.type === 'text' && part.value.trim()) {
        hasTextAfter = true;
        continue;
      }
      if (part.type === 'tool' && hasTextAfter) {
        indices.add(index);
      }
    }

    return indices;
  }, [assistantParts]);

  const getToolFollowupLabel = (trace: ToolTrace): string | undefined => {
    if (trace.kind === 'search') {
      return trace.success === false ? '搜索已结束，正在整理现有内容' : '搜索完成，正在组织结果';
    }
    if (trace.mode === 'edit') {
      return trace.success === false ? '修改已结束，正在整理说明' : '图片已大致构建完成，正在补充细节，这可能需要一定时间';
    }
    return trace.success === false ? '生成已结束，正在整理说明' : '图片已大致构建完成，正在补充细节，这可能需要一定时间';
  };

  return (
    <div className={`flex gap-4 animate-slide-up group ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-transform duration-200 hover:scale-105 ${isUser ? 'bg-primary text-primary-foreground' : ''}`}
      >
        {isUser ? (
          <User className="w-5 h-5" />
        ) : (
          <AssistantAvatar resolvedTheme={resolvedTheme} spinning={isStreaming} />
        )}
      </div>

      <div className={`flex flex-col ${isUser ? 'items-end max-w-[75%]' : 'items-start max-w-[85%] min-w-0 flex-1'}`}>
        {isUser ? (
          <>
            <div className="rounded-2xl px-4 py-3 bg-primary text-primary-foreground transition-shadow duration-200 hover:shadow-md">
              <div className="prose prose-sm max-w-none prose-invert" style={{ overflowWrap: 'anywhere' }}>
                {message.images && message.images.length > 0 && (
                  <div className={`flex gap-2 flex-wrap ${message.content && message.content !== '(图片)' ? 'mb-2' : ''}`}>
                    {message.images.map((img, i) => (
                      <img
                        key={i}
                        src={img}
                        alt={`图片 ${i + 1}`}
                        className="rounded-lg max-w-[200px] max-h-[200px] object-cover cursor-pointer"
                        onClick={() => window.open(img, '_blank', 'noopener,noreferrer')}
                      />
                    ))}
                  </div>
                )}
                {(!message.images || message.content !== '(图片)') && (
                  <MarkdownBlock content={renderedContent} isUser />
                )}
              </div>
            </div>

            <div className={`flex items-center gap-1 mt-1 transition-opacity ${showRecallConfirm ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <button
                onClick={handleCopyMessage}
                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                title="复制"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
              {onRecall && (
                showRecallConfirm ? (
                  <>
                    <button
                      onClick={() => { setShowRecallConfirm(false); onRecall(message); }}
                      className="p-1 rounded text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                      title="确认撤回"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setShowRecallConfirm(false)}
                      className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      title="取消"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setShowRecallConfirm(true)}
                    className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    title="撤回"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                )
              )}
            </div>
          </>
        ) : (
          <div className="w-full text-foreground">
            {isWaitingOnly ? (
              <div className="py-2">
                <div className="text-sm font-medium">{waitingMessage}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {waitingSeconds > 0 ? `${waitingSeconds}s` : '请稍候'}
                </div>
              </div>
            ) : (
              <>
                {assistantParts.length > 0 ? (
                  assistantParts.map((part, index) => {
                    if (part.type === 'text') {
                      const showCursor = isStreaming && index === assistantParts.length - 1;
                      return (
                        <div key={`text-${index}`} className="py-1">
                          <MarkdownBlock
                            content={part.value}
                            isUser={false}
                            showCursor={showCursor}
                            hiddenImageUrls={hiddenToolImageUrls}
                          />
                        </div>
                      );
                    }

                    const trace = toolTrace[part.traceIdx];
                    if (!trace) return null;
                    const isSettlingTool = (
                      !isUser
                      && isStreaming
                      && !isWaitingOnly
                      && !hasRunningTool
                      && !toolPartIndicesWithTextAfter.has(index)
                    );
                    if (trace.kind === 'search') {
                      return (
                        <SearchToolCard
                          key={`tool-${part.traceIdx}`}
                          trace={trace}
                          seconds={trace.status === 'running' ? searchSeconds : trace.durationSeconds ?? 0}
                          followupLabel={isSettlingTool ? getToolFollowupLabel(trace) : undefined}
                        />
                      );
                    }
                    return (
                      <ImageToolCard
                        key={`tool-${part.traceIdx}`}
                        trace={trace}
                        seconds={
                          trace.status === 'running'
                            ? imageGenSeconds
                            : isSettlingTool
                              ? (trace.durationSeconds ?? 0) + toolFollowupSeconds
                              : trace.durationSeconds ?? 0
                        }
                        followupLabel={isSettlingTool ? getToolFollowupLabel(trace) : undefined}
                        settling={isSettlingTool}
                      />
                    );
                  })
                ) : (
                  <div className="py-1">
                    <MarkdownBlock
                      content={renderedContent}
                      isUser={false}
                      showCursor={isStreaming && !!renderedContent.trim()}
                      hiddenImageUrls={hiddenToolImageUrls}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function areMessagePropsEqual(prev: MessageProps, next: MessageProps) {
  return (
    prev.message === next.message &&
    prev.contentOverride === next.contentOverride &&
    prev.onRecall === next.onRecall &&
    prev.isStreaming === next.isStreaming &&
    prev.waitingSeconds === next.waitingSeconds &&
    prev.searchSeconds === next.searchSeconds &&
    prev.imageGenSeconds === next.imageGenSeconds &&
    prev.toolFollowupSeconds === next.toolFollowupSeconds &&
    prev.thinkingEnabled === next.thinkingEnabled
  );
}

export const Message = memo(MessageComponent, areMessagePropsEqual);
