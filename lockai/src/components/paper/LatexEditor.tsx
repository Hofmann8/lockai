'use client';

import { ChangeEvent, KeyboardEvent, useRef, useEffect } from 'react';

interface LatexEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function LatexEditor({ value, onChange, placeholder }: LatexEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [value]);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newValue);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
        }
      });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2">
        <span className="text-sm font-medium text-foreground">LaTeX 源码</span>
        <span className="text-xs text-muted-foreground">支持标准 LaTeX 数学符号</span>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || '输入 LaTeX 代码...'}
        spellCheck={false}
        className="min-h-[300px] flex-1 resize-none bg-background p-4 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}
