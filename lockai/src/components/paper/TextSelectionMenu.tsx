'use client';

import { useEffect, useState, useCallback } from 'react';
import { Sparkles, BookOpen, FileText, Languages } from 'lucide-react';

export type AiAssistAction = 'explain' | 'summarize' | 'translate';

interface TextSelectionMenuProps {
  onAction: (text: string, action: AiAssistAction) => void;
  containerRef?: React.RefObject<HTMLElement | null>;
}

interface MenuPosition {
  x: number;
  y: number;
}

export function TextSelectionMenu({ onAction, containerRef }: TextSelectionMenuProps) {
  const [selectedText, setSelectedText] = useState('');
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (text && text.length > 0) {
      const range = selection?.getRangeAt(0);
      if (range) {
        const rect = range.getBoundingClientRect();
        setMenuPosition({
          x: rect.left + rect.width / 2,
          y: rect.top - 10,
        });
        setSelectedText(text);
        setIsVisible(true);
      }
    } else {
      setIsVisible(false);
      setSelectedText('');
    }
  }, []);

  const handleMouseDown = useCallback((e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.text-selection-menu')) {
      setIsVisible(false);
    }
  }, []);

  useEffect(() => {
    const container = containerRef?.current || document;
    container.addEventListener('mouseup', handleMouseUp as EventListener);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      container.removeEventListener('mouseup', handleMouseUp as EventListener);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [containerRef, handleMouseUp, handleMouseDown]);

  const handleAction = (action: AiAssistAction) => {
    if (selectedText) {
      onAction(selectedText, action);
      setIsVisible(false);
      window.getSelection()?.removeAllRanges();
    }
  };

  if (!isVisible || !menuPosition) return null;

  return (
    <div
      className="text-selection-menu fixed z-50 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
      style={{
        left: menuPosition.x,
        top: menuPosition.y,
        transform: 'translate(-50%, -100%)',
      }}
    >
      <button
        onClick={() => handleAction('explain')}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent"
        title="AI 解释"
      >
        <Sparkles className="h-4 w-4" />
        <span>解释</span>
      </button>
      <button
        onClick={() => handleAction('summarize')}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent"
        title="AI 总结"
      >
        <FileText className="h-4 w-4" />
        <span>总结</span>
      </button>
      <button
        onClick={() => handleAction('translate')}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-popover-foreground transition-colors hover:bg-accent"
        title="AI 翻译"
      >
        <Languages className="h-4 w-4" />
        <span>翻译</span>
      </button>
    </div>
  );
}
