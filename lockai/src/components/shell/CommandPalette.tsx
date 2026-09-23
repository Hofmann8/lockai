'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, MessageSquare, Moon, PanelLeft, Search, Settings, SquarePen, Sun } from 'lucide-react';
import type { ChatSession } from '@/types';
import { Dialog } from '@/components/ui/Dialog';
import { useTheme } from '@/lib/theme';
import { cn, modKey } from '@/lib/cn';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  sessions: ChatSession[];
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onToggleSidebar: () => void;
}

interface Item {
  id: string;
  group: string;
  icon: ReactNode;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

function relativeDay(date: Date) {
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose } = props;
  return (
    <Dialog open={open} onClose={onClose} align="top" hideClose className="max-w-[560px] overflow-hidden rounded-[22px] p-0">
      {open && <PaletteBody {...props} />}
    </Dialog>
  );
}

function PaletteBody({ onClose, sessions, onSelectSession, onNewChat, onOpenSettings, onOpenShortcuts, onToggleSidebar }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme, setTheme } = useTheme();

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const close = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const actions: Item[] = [
      { id: 'new', group: '操作', icon: <SquarePen className="h-4 w-4" />, label: '新对话', hint: `${modKey()} ⇧ O`, keywords: 'new chat xin', run: close(onNewChat) },
      {
        id: 'theme',
        group: '操作',
        icon: resolvedTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
        label: resolvedTheme === 'dark' ? '切换到浅色' : '切换到深色',
        keywords: 'theme dark light zhuti',
        run: close(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark', { x: window.innerWidth / 2, y: window.innerHeight * 0.2 })),
      },
      { id: 'sidebar', group: '操作', icon: <PanelLeft className="h-4 w-4" />, label: '显示 / 收起侧栏', hint: `${modKey()} ⇧ S`, keywords: 'sidebar', run: close(onToggleSidebar) },
      { id: 'settings', group: '操作', icon: <Settings className="h-4 w-4" />, label: '设置', hint: `${modKey()} ,`, keywords: 'settings shezhi', run: close(onOpenSettings) },
      { id: 'keys', group: '操作', icon: <Keyboard className="h-4 w-4" />, label: '快捷键', hint: `${modKey()} /`, keywords: 'shortcuts keyboard', run: close(onOpenShortcuts) },
    ];
    const chats: Item[] = sessions.map((s) => ({
      id: s.id,
      group: q ? '对话' : '最近对话',
      icon: <MessageSquare className="h-4 w-4" />,
      label: s.title || '新对话',
      hint: relativeDay(s.updatedAt),
      run: close(() => onSelectSession(s.id)),
    }));
    if (!q) return [...chats.slice(0, 8), ...actions];
    const match = (item: Item) => item.label.toLowerCase().includes(q) || (item.keywords ?? '').includes(q);
    return [...chats.filter(match).slice(0, 30), ...actions.filter(match)];
  }, [onClose, onNewChat, onOpenSettings, onOpenShortcuts, onSelectSession, onToggleSidebar, query, resolvedTheme, sessions, setTheme]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let lastGroup = '';

  return (
    <div className="flex max-h-[min(560px,70vh)] flex-col">
      <div className="flex items-center gap-3 border-b border-line px-5">
        <Search className="h-[18px] w-[18px] shrink-0 text-fg-faint" />
        <input
          data-autofocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              items[active]?.run();
            }
          }}
          placeholder="搜索对话，或输入命令…"
          className="h-14 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-faint"
        />
        <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-fg-faint">Esc</kbd>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 && <p className="py-10 text-center text-[13px] text-fg-faint">没有找到相关内容</p>}
        {items.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={`${item.group}-${item.id}`}>
              {header && <div className="px-3 pb-1 pt-2.5 text-[11.5px] font-medium text-fg-faint">{header}</div>}
              <button
                type="button"
                data-index={index}
                onMouseMove={() => setActive(index)}
                onClick={item.run}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition-colors',
                  index === active ? 'bg-surface-2 text-fg' : 'text-fg-soft',
                )}
              >
                <span className={cn('shrink-0', index === active ? 'text-fg' : 'text-fg-faint')}>{item.icon}</span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && <span className="shrink-0 text-xs text-fg-faint">{item.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
