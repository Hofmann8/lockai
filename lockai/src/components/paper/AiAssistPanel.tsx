'use client';

import { useState } from 'react';
import { X, Sparkles, FileText, Languages, Loader2, Copy, Check } from 'lucide-react';
import { requestPaperAssist } from '@/lib/api';
import type { AiAssistAction } from './TextSelectionMenu';

interface AiAssistPanelProps {
  selectedText: string;
  action: AiAssistAction;
  onClose: () => void;
}

const ACTION_LABELS: Record<AiAssistAction, { label: string; icon: typeof Sparkles }> = {
  explain: { label: '解释', icon: Sparkles },
  summarize: { label: '总结', icon: FileText },
  translate: { label: '翻译', icon: Languages },
};

export function AiAssistPanel({ selectedText, action, onClose }: AiAssistPanelProps) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const { label, icon: Icon } = ACTION_LABELS[action];

  const handleRequest = async () => {
    setIsLoading(true);
    setError(null);
    setResult(null);

    const response = await requestPaperAssist({ text: selectedText, action });

    if (response.error) {
      setError(response.error);
    } else {
      setResult(response.result);
    }

    setIsLoading(false);
  };

  const handleCopy = async () => {
    if (result) {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          <span className="font-medium text-foreground">AI {label}</span>
        </div>
        <button
          onClick={onClose}
          className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="mb-4">
          <h4 className="mb-2 text-sm font-medium text-muted-foreground">选中文本</h4>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-sm text-foreground line-clamp-4">{selectedText}</p>
          </div>
        </div>

        {!result && !error && !isLoading && (
          <button
            onClick={handleRequest}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Icon className="h-4 w-4" />
            开始{label}
          </button>
        )}

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">AI 正在{label}中...</p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
            <p className="text-sm text-destructive">{error}</p>
            <button
              onClick={handleRequest}
              className="mt-3 cursor-pointer text-sm text-primary hover:underline"
            >
              重试
            </button>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-muted-foreground">{label}结果</h4>
              <button
                onClick={handleCopy}
                className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    已复制
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    复制
                  </>
                )}
              </button>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{result}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
