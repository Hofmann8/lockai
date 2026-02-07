'use client';

import { useState, useCallback, KeyboardEvent } from 'react';
import { Send, Loader2, FileText } from 'lucide-react';

interface GenerateFormProps {
  onSubmit: (topic: string) => void;
  disabled?: boolean;
}

export function GenerateForm({ onSubmit, disabled = false }: GenerateFormProps) {
  const [topic, setTopic] = useState('');

  const handleSubmit = useCallback(() => {
    const trimmed = topic.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
  }, [topic, disabled, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const isValid = topic.trim().length > 0;

  return (
    <div className="w-full max-w-2xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 text-primary mb-4">
          <FileText className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold text-foreground mb-2">
          一句话，完成论文
        </h2>
        <p className="text-sm text-muted-foreground">
          输入研究主题，AI 自动完成文献检索、结构规划、内容撰写与 LaTeX 排版
        </p>
      </div>

      {/* Input area */}
      <div className="relative rounded-2xl bg-card border border-border transition-shadow duration-200 hover:shadow-md focus-within:shadow-md focus-within:border-primary/50">
        <div className="flex items-center gap-3 px-4 py-3">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入研究主题，例如：基于 Transformer 的图像分类方法综述"
            disabled={disabled}
            className="
              flex-1 bg-transparent text-foreground placeholder:text-muted-foreground
              focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
              text-base
            "
          />
          <button
            onClick={handleSubmit}
            disabled={disabled || !isValid}
            className="
              shrink-0 w-10 h-10 rounded-xl bg-primary text-primary-foreground
              flex items-center justify-center
              hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed
              transition-colors duration-200 cursor-pointer
            "
            aria-label="开始生成"
          >
            {disabled ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-muted-foreground text-center mt-3">
        LockAI 可能会出错，请核实重要信息。仅供日常课程作业的辅助参考，不可用于正式学术发表
      </p>
    </div>
  );
}
