'use client';

import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { AlertCircle } from 'lucide-react';

interface LatexPreviewProps {
  content: string;
}

interface RenderResult {
  html: string;
  error: string | null;
}

function renderLatex(content: string): RenderResult {
  if (!content.trim()) {
    return { html: '', error: null };
  }

  const lines = content.split('\n');
  const renderedLines: string[] = [];
  let hasError = false;
  let errorMessage: string | null = null;

  for (const line of lines) {
    if (!line.trim()) {
      renderedLines.push('<br/>');
      continue;
    }

    const displayMathRegex = /\$\$([\s\S]*?)\$\$/g;
    const inlineMathRegex = /\$((?!\$)[\s\S]*?)\$/g;

    let processedLine = line;
    let lineHasError = false;

    processedLine = processedLine.replace(displayMathRegex, (_, math) => {
      try {
        return katex.renderToString(math.trim(), {
          displayMode: true,
          throwOnError: true,
          strict: false,
        });
      } catch (e) {
        lineHasError = true;
        hasError = true;
        errorMessage = e instanceof Error ? e.message : '渲染错误';
        return `<span class="text-destructive">[错误: ${math.trim().substring(0, 20)}...]</span>`;
      }
    });

    processedLine = processedLine.replace(inlineMathRegex, (_, math) => {
      try {
        return katex.renderToString(math.trim(), {
          displayMode: false,
          throwOnError: true,
          strict: false,
        });
      } catch (e) {
        lineHasError = true;
        hasError = true;
        errorMessage = e instanceof Error ? e.message : '渲染错误';
        return `<span class="text-destructive">[错误: ${math.trim().substring(0, 20)}...]</span>`;
      }
    });

    if (!lineHasError && !displayMathRegex.test(line) && !inlineMathRegex.test(line)) {
      try {
        processedLine = katex.renderToString(line.trim(), {
          displayMode: true,
          throwOnError: true,
          strict: false,
        });
      } catch {
        processedLine = `<p class="my-2">${line}</p>`;
      }
    }

    renderedLines.push(processedLine);
  }

  return {
    html: renderedLines.join('\n'),
    error: hasError ? errorMessage : null,
  };
}

export function LatexPreview({ content }: LatexPreviewProps) {
  const { html, error } = useMemo(() => renderLatex(content), [content]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2">
        <span className="text-sm font-medium text-foreground">预览</span>
        {error && (
          <div className="flex items-center gap-1 text-destructive">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs">存在语法错误</span>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto bg-background p-4">
        {content.trim() ? (
          <div
            className="latex-preview text-foreground"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="text-center text-muted-foreground">输入 LaTeX 代码以预览</p>
        )}
      </div>
    </div>
  );
}
