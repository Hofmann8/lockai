'use client';

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
}

export function MessageInput({ onSend, disabled = false, onActiveChange }: MessageInputProps) {
  const [value, setValue] = useState('');
  const [isHovered, setIsHovered] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isActive = isHovered || value.length > 0;

  useEffect(() => {
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled) return;
    onSend(value);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return (
    <div 
      className="relative flex items-end gap-3 p-4 rounded-2xl bg-card border border-border"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          adjustHeight();
        }}
        onKeyDown={handleKeyDown}
        placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
        disabled={disabled}
        rows={1}
        className="
          flex-1 resize-none bg-transparent text-foreground placeholder:text-muted-foreground
          focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
          text-base leading-relaxed
        "
      />
      <button
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        className="
          shrink-0 w-10 h-10 rounded-xl bg-primary text-primary-foreground
          flex items-center justify-center
          hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors duration-200 cursor-pointer
        "
        aria-label="发送消息"
      >
        {disabled ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : (
          <Send className="w-5 h-5" />
        )}
      </button>
    </div>
  );
}
