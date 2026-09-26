'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Sun,
  Trash2,
} from 'lucide-react';
import type { AuthState, ChatSession } from '@/types';
import type { ChatActivity } from '@/components/AppShell';
import { fetchUserAvatar, getAuthState, getSignedUrlExpiry, isSignedUrlExpired, logout, updateAvatarUrl } from '@/lib/auth';
import { useTheme, type Theme } from '@/lib/theme';
import { cn, modKey } from '@/lib/cn';
import { LockMark, Wordmark } from '@/components/brand/LockMark';
import { MenuItem, MenuSeparator, Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';

interface SidebarProps {
  sessions: ChatSession[];
  loaded: boolean;
  currentSessionId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  activity: ChatActivity;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onTogglePin: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}

/* ------------------------------------------------------------------ */

const DAY = 24 * 60 * 60 * 1000;

function dayStamp(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function groupSessions(sessions: ChatSession[]) {
  const today = dayStamp(new Date());
  const groups: Array<{ label: string; items: ChatSession[] }> = [
    { label: '置顶', items: [] },
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '七天内', items: [] },
    { label: '三十天内', items: [] },
    { label: '更早', items: [] },
  ];
  for (const s of sessions) {
    if (s.pinned) {
      groups[0].items.push(s);
      continue;
    }
    const days = Math.floor((today - dayStamp(new Date(s.updatedAt))) / DAY);
    const index = days <= 0 ? 1 : days === 1 ? 2 : days < 7 ? 3 : days < 30 ? 4 : 5;
    groups[index].items.push(s);
  }
  return groups.filter((g) => g.items.length > 0);
}

/* ------------------------------------------------------------------ */

function useAvatar() {
  const [user, setUser] = useState<AuthState['user']>(undefined);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const refreshing = useRef(false);
  const erroredFor = useRef<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    urlRef.current = avatarUrl;
  }, [avatarUrl]);

  const refresh = useCallback(async (force = false) => {
    if (refreshing.current) return;
    const current = urlRef.current;
    if (!force && current && !isSignedUrlExpired(current)) return;
    refreshing.current = true;
    try {
      const url = await fetchUserAvatar('avatarmd');
      if (url) {
        erroredFor.current = null;
        setAvatarUrl(url);
        updateAvatarUrl(url);
      } else if (force && current) {
        setAvatarUrl(null);
        updateAvatarUrl(null);
      }
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    const auth = getAuthState();
    setUser(auth.user);
    const initial = auth.user?.avatarUrl || null;
    setAvatarUrl(initial);
    urlRef.current = initial;
    void refresh(false);
  }, [refresh]);

  // 签名链接过期前 5 分钟续签
  useEffect(() => {
    if (!avatarUrl) return;
    const expiresAt = getSignedUrlExpiry(avatarUrl);
    if (!expiresAt) return;
    const timer = window.setTimeout(() => void refresh(true), Math.max(0, expiresAt - 5 * 60 * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [avatarUrl, refresh]);

  const onError = useCallback(() => {
    const current = urlRef.current;
    if (!current) return;
    if (erroredFor.current === current) {
      setAvatarUrl(null);
      updateAvatarUrl(null);
      return;
    }
    erroredFor.current = current;
    void refresh(true);
  }, [refresh]);

  return { user, avatarUrl, onError };
}

function Avatar({ url, name, onError, size = 28 }: { url: string | null; name?: string; onError: () => void; size?: number }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" onError={onError} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-medium text-fg-soft"
      style={{ width: size, height: size }}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

/* ------------------------------------------------------------------ */

function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const title = session.title || '新对话';

  if (editing) {
    return (
      <div className="px-1.5 py-0.5">
        <input
          autoFocus
          defaultValue={title}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            setEditing(false);
            const next = e.target.value.trim();
            if (next && next !== title) onRename(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.value = title;
              e.currentTarget.blur();
            }
          }}
          className="h-8 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-[13.5px] text-fg outline-none"
        />
      </div>
    );
  }

  return (
    <div className={cn('group/item relative flex items-center rounded-xl transition-colors', active ? 'bg-surface-2' : 'hover:bg-surface-2/70')}>
      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={() => setEditing(true)}
        className={cn(
          'min-w-0 flex-1 truncate py-2 pl-3.5 pr-2 text-left text-[13.5px] transition-colors',
          active ? 'text-fg' : 'text-fg-soft group-hover/item:text-fg',
        )}
      >
        <span className="pair-rule" data-active={active}>{title}</span>
      </button>
      {session.running && (
        <span
          role="status"
          aria-label="正在回答"
          title="正在回答"
          className={cn(
            'pointer-events-none absolute right-[15px] top-1/2 -mt-[3px] h-1.5 w-1.5 rounded-full bg-accent animate-breathe transition-opacity duration-150',
            menu ? 'opacity-0' : 'group-hover/item:opacity-0 max-md:hidden',
          )}
        />
      )}
      <button
        ref={anchor}
        type="button"
        aria-label="更多操作"
        onClick={() => setMenu((v) => !v)}
        className={cn(
          'mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-faint transition-[opacity,color] hover:text-fg',
          menu ? 'opacity-100' : 'opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 max-md:opacity-100',
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <Popover open={menu} onOpenChange={setMenu} anchor={anchor} placement="bottom-end" className="w-44">
        <MenuItem
          icon={<Pencil className="h-3.5 w-3.5" />}
          label="重命名"
          onSelect={() => {
            setMenu(false);
            setEditing(true);
          }}
        />
        <MenuItem
          icon={session.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          label={session.pinned ? '取消置顶' : '置顶'}
          onSelect={() => {
            setMenu(false);
            onTogglePin();
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          danger
          onSelect={() => {
            setMenu(false);
            onDelete();
          }}
        />
      </Popover>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ value: Theme; icon: typeof Sun; label: string }> = [
    { value: 'light', icon: Sun, label: '浅色' },
    { value: 'dark', icon: Moon, label: '深色' },
    { value: 'system', icon: Monitor, label: '跟随系统' },
  ];
  return (
    <div className="flex items-center justify-between px-2.5 py-1.5">
      <span className="text-[13.5px] text-fg">外观</span>
      <div className="flex gap-0.5 rounded-xl bg-surface-2 p-0.5">
        {options.map(({ value, icon: Icon, label }) => (
          <Tooltip key={value} label={label}>
            <button
              type="button"
              aria-label={label}
              aria-pressed={theme === value}
              onClick={(e: MouseEvent) => setTheme(value, { x: e.clientX, y: e.clientY })}
              className={cn(
                'flex h-7 w-8 items-center justify-center rounded-[10px] transition-colors',
                theme === value ? 'bg-surface text-fg shadow-soft' : 'text-fg-faint hover:text-fg',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: string }) {
  return <span className="font-sans text-[11px] tracking-wide text-fg-faint">{children}</span>;
}

/* ------------------------------------------------------------------ */

export function Sidebar(props: SidebarProps) {
  const { collapsed, mobileOpen, onMobileClose } = props;

  // 手机上打开抽屉时锁住背景滚动，Esc 关闭
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onMobileClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  return (
    <>
      <aside
        className={cn(
          'relative hidden h-dvh shrink-0 flex-col border-r border-line bg-sunken/60 transition-[width] duration-300 ease-out md:flex',
          collapsed ? 'w-[60px]' : 'w-[272px]',
        )}
      >
        {collapsed ? <Rail {...props} /> : <Panel {...props} />}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-[150] md:hidden">
          <div className="absolute inset-0 bg-scrim animate-fade" onClick={onMobileClose} />
          <aside className="absolute inset-y-0 left-0 flex w-[84vw] max-w-[300px] flex-col border-r border-line bg-bg shadow-pop animate-[drawer-in_0.32s_var(--ease-out)_both]">
            <Panel {...props} mobile />
          </aside>
        </div>
      )}
    </>
  );
}

function UserMenu({ onOpenSettings, onOpenShortcuts, compact }: { onOpenSettings: () => void; onOpenShortcuts: () => void; compact?: boolean }) {
  const router = useRouter();
  const { user, avatarUrl, onError } = useAvatar();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="账户菜单"
        className={cn(
          'flex items-center gap-2.5 rounded-xl transition-colors hover:bg-surface-2',
          compact ? 'h-10 w-10 justify-center' : 'h-11 w-full px-2.5',
          open && 'bg-surface-2',
        )}
      >
        <Avatar url={avatarUrl} name={user?.name} onError={onError} />
        {!compact && <span className="min-w-0 flex-1 truncate text-left text-[13.5px] text-fg">{user?.name || '未登录'}</span>}
      </button>
      <Popover open={open} onOpenChange={setOpen} anchor={anchor} placement="top-start" className="w-64">
        <div className="flex items-center gap-2.5 px-2.5 pb-2 pt-1.5">
          <Avatar url={avatarUrl} name={user?.name} onError={onError} size={34} />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium text-fg">{user?.name}</div>
            <div className="truncate text-xs text-fg-faint">{user?.email}</div>
          </div>
        </div>
        <MenuSeparator />
        <ThemeSwitch />
        <MenuItem
          icon={<Settings className="h-4 w-4" />}
          label="设置"
          hint={`${modKey()} ,`}
          onSelect={() => {
            setOpen(false);
            onOpenSettings();
          }}
        />
        <MenuItem
          icon={<Keyboard className="h-4 w-4" />}
          label="快捷键"
          hint={`${modKey()} /`}
          onSelect={() => {
            setOpen(false);
            onOpenShortcuts();
          }}
        />
        <MenuSeparator />
        <MenuItem
          icon={<LogOut className="h-4 w-4" />}
          label="退出登录"
          onSelect={() => {
            setOpen(false);
            logout();
            router.push('/');
          }}
        />
      </Popover>
    </>
  );
}

function Panel({
  sessions,
  loaded,
  currentSessionId,
  onToggleCollapsed,
  onMobileClose,
  activity,
  onSelect,
  onNewChat,
  onRename,
  onTogglePin,
  onDelete,
  onOpenSearch,
  onOpenSettings,
  onOpenShortcuts,
  mobile,
}: SidebarProps & { mobile?: boolean }) {
  const groups = useMemo(() => groupSessions(sessions), [sessions]);

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade">
      <div className="flex h-14 shrink-0 items-center justify-between pl-4 pr-2">
        <button type="button" onClick={onNewChat} className="flex items-center gap-2 rounded-lg" aria-label="LockAI 首页">
          <LockMark size={22} state={activity.busy ? 'busy' : 'idle'} snapKey={activity.snapKey} className="text-fg" />
          <Wordmark />
        </button>
        <Tooltip label={mobile ? '关闭' : `收起侧栏 · ${modKey()}⇧S`} side="bottom">
          <button
            type="button"
            onClick={mobile ? onMobileClose : onToggleCollapsed}
            aria-label="收起侧栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-faint transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <PanelLeftClose className="h-[18px] w-[18px]" />
          </button>
        </Tooltip>
      </div>

      <div className="space-y-0.5 px-2 pb-2">
        <button
          type="button"
          onClick={onNewChat}
          className="group flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] text-fg transition-colors hover:bg-surface-2"
        >
          <SquarePen className="h-4 w-4 text-fg-soft" />
          <span className="flex-1 text-left">新对话</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden">
            <Kbd>{`${modKey()} ⇧ O`}</Kbd>
          </span>
        </button>
        <button
          type="button"
          onClick={onOpenSearch}
          className="group flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">搜索对话</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden">
            <Kbd>{`${modKey()} K`}</Kbd>
          </span>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 no-scrollbar [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%-16px),transparent)]">
        {!loaded ? (
          <div className="space-y-2 px-2.5 pt-4">
            {[70, 52, 84, 60, 45].map((w, i) => (
              <div key={i} className="h-3.5 animate-pulse rounded-full bg-surface-2" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="px-3 pt-6 text-[12.5px] leading-relaxed text-fg-faint">还没有对话。<br />说第一句话，它就会出现在这里。</p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="pt-3">
              <div className="flex items-center gap-1.5 px-3 pb-1 text-[11.5px] font-medium text-fg-faint">
                {group.label === '置顶' && <Pin className="h-3 w-3" />}
                {group.label}
              </div>
              <div className="space-y-px">
                {group.items.map((s) => (
                  <SessionItem
                    key={s.id}
                    session={s}
                    active={s.id === currentSessionId}
                    onSelect={() => onSelect(s.id)}
                    onRename={(title) => void onRename(s.id, title)}
                    onTogglePin={() => void onTogglePin(s.id)}
                    onDelete={() => onDelete(s.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </nav>

      <div className="shrink-0 border-t border-line p-2">
        <UserMenu onOpenSettings={onOpenSettings} onOpenShortcuts={onOpenShortcuts} />
      </div>
    </div>
  );
}

function Rail({ onToggleCollapsed, activity, onNewChat, onOpenSearch, onOpenSettings, onOpenShortcuts }: SidebarProps) {
  const [hover, setHover] = useState(false);
  const btn = 'flex h-10 w-10 items-center justify-center rounded-xl text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg';
  return (
    <div className="flex h-full flex-col items-center py-2 animate-fade">
      <Tooltip label={`展开侧栏 · ${modKey()}⇧S`} side="right">
        <button
          type="button"
          onClick={onToggleCollapsed}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          aria-label="展开侧栏"
          className={cn(btn, 'text-fg')}
        >
          {hover ? (
            <PanelLeftOpen className="h-[18px] w-[18px] animate-fade" />
          ) : (
            <LockMark size={22} state={activity.busy ? 'busy' : 'idle'} snapKey={activity.snapKey} />
          )}
        </button>
      </Tooltip>
      <div className="mt-2 flex flex-col gap-1">
        <Tooltip label={`新对话 · ${modKey()}⇧O`} side="right">
          <button type="button" onClick={onNewChat} aria-label="新对话" className={btn}>
            <SquarePen className="h-[18px] w-[18px]" />
          </button>
        </Tooltip>
        <Tooltip label={`搜索 · ${modKey()}K`} side="right">
          <button type="button" onClick={onOpenSearch} aria-label="搜索" className={btn}>
            <Search className="h-[18px] w-[18px]" />
          </button>
        </Tooltip>
      </div>
      <div className="mt-auto">
        <UserMenu compact onOpenSettings={onOpenSettings} onOpenShortcuts={onOpenShortcuts} />
      </div>
    </div>
  );
}
