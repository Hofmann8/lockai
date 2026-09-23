'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { ChatSession } from '@/types';
import { Sidebar } from '@/components/shell/Sidebar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { SettingsDialog } from '@/components/shell/SettingsDialog';
import { ShortcutsDialog } from '@/components/shell/ShortcutsDialog';
import { deleteSession, getSessions, updateSession } from '@/lib/chat-history';
import { toast } from '@/components/ui/Toast';

export interface ChatActivity {
  busy: boolean;
  snapKey: number;
}

interface AppShellContextType {
  sessions: ChatSession[];
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  loadSessions: () => Promise<ChatSession[]>;
  newChat: () => void;
  renameSession: (id: string, title: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  /** 先从列表里藏起来，几秒内可撤销，过期才真正删除 */
  removeSession: (id: string) => void;
  openSidebar: () => void;
  setChatActivity: (activity: ChatActivity) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const AppShellContext = createContext<AppShellContextType | null>(null);

export function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) throw new Error('useAppShell must be used within AppShell');
  return context;
}

const COLLAPSE_KEY = 'lockai_sidebar_collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [activity, setActivity] = useState<ChatActivity>({ busy: false, snapKey: 0 });
  const pendingDeletes = useRef<Set<string>>(new Set());

  useEffect(() => {
    setSidebarCollapsedState(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await getSessions();
    setSessions(data);
    setSessionsLoaded(true);
    return data;
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const visibleSessions = useMemo(() => sessions.filter((s) => !hidden.has(s.id)), [hidden, sessions]);

  const newChat = useCallback(() => {
    setCurrentSessionId(null);
    setMobileOpen(false);
  }, []);

  const selectSession = useCallback((id: string) => {
    setCurrentSessionId(id);
    setMobileOpen(false);
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, title } : s)));
    if (!(await updateSession(id, { title }))) {
      toast('重命名失败', { tone: 'danger' });
      void loadSessions();
    }
  }, [loadSessions]);

  const togglePin = useCallback(async (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    const pinned = !target.pinned;
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, pinned } : s)));
    if (!(await updateSession(id, { pinned }))) toast('操作失败', { tone: 'danger' });
    void loadSessions();
  }, [loadSessions, sessions]);

  const removeSession = useCallback((id: string) => {
    const target = sessions.find((s) => s.id === id);
    const wasCurrent = id === currentSessionId;
    setHidden((prev) => new Set(prev).add(id));
    pendingDeletes.current.add(id);
    if (wasCurrent) setCurrentSessionId(null);
    const unhide = () => setHidden((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    toast(`已删除「${target?.title || '对话'}」`, {
      duration: 5000,
      action: {
        label: '撤销',
        onClick: () => {
          pendingDeletes.current.delete(id);
          unhide();
          if (wasCurrent) setCurrentSessionId(id);
        },
      },
      onExpire: async () => {
        if (!pendingDeletes.current.has(id)) return;
        pendingDeletes.current.delete(id);
        const ok = await deleteSession(id);
        if (!ok) toast('删除失败，请重试', { tone: 'danger' });
        await loadSessions();
        unhide();
      },
    });
  }, [currentSessionId, loadSessions, sessions]);

  // 撤销窗口内关掉页面：把没删完的补发出去
  useEffect(() => {
    const flush = () => {
      for (const id of pendingDeletes.current) void deleteSession(id, { keepalive: true });
      pendingDeletes.current.clear();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k' && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (key === 'o' && e.shiftKey) {
        e.preventDefault();
        newChat();
      } else if (key === 's' && e.shiftKey) {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
      } else if (key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat, setSidebarCollapsed, sidebarCollapsed]);

  const contextValue: AppShellContextType = {
    sessions: visibleSessions,
    currentSessionId,
    setCurrentSessionId,
    loadSessions,
    newChat,
    renameSession,
    togglePin,
    removeSession,
    openSidebar: () => setMobileOpen(true),
    setChatActivity: setActivity,
    sidebarCollapsed,
    setSidebarCollapsed,
  };

  return (
    <AppShellContext.Provider value={contextValue}>
      <div className="flex h-dvh overflow-hidden bg-bg">
        <Sidebar
          sessions={visibleSessions}
          loaded={sessionsLoaded}
          currentSessionId={pathname === '/chat' ? currentSessionId : null}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
          activity={activity}
          onSelect={selectSession}
          onNewChat={newChat}
          onRename={renameSession}
          onTogglePin={togglePin}
          onDelete={removeSession}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
        <main className="flex min-w-0 flex-1">{children}</main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        sessions={visibleSessions}
        onSelectSession={selectSession}
        onNewChat={newChat}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </AppShellContext.Provider>
  );
}
