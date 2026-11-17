'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { ChatSession, RunPhase } from '@/types';
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

interface LocalRun {
  phase: Exclude<RunPhase, 'end'>;
  since: number;
  /** 服务端列表里见过它在跑 */
  seen: boolean;
  /** 哪条连接标的：旧连接迟到的收尾不会把新一轮收掉 */
  owner?: object;
}

/** 回答刚起步时服务端可能还没登记：这段时间里列表说没在跑，先信本端 */
const RUN_GRACE_MS = 20_000;

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
  /** 一轮回答的头尾：发出 / 接上时 live，离开对话时 detached，收尾时 end。owner 是标记它的那条连接，不传表示以服务端为准直接改 */
  trackRun: (sessionId: string, phase: RunPhase, owner?: object) => void;
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
/** 有对话在后台回答时，多久刷新一次列表（看它们做完没有） */
const RUNNING_POLL_MS = 4000;

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
  const currentRef = useRef<string | null>(null);
  const runningRef = useRef<Set<string> | null>(null);
  // 本端知道的进行中回答。服务端列表有滞后（刚发出时还没登记），侧栏的"在回答"取两边的并集
  const runsRef = useRef<ReadonlyMap<string, LocalRun>>(new Map());
  const [runs, setRuns] = useState<ReadonlyMap<string, LocalRun>>(runsRef.current);
  const commitRuns = useCallback((next: ReadonlyMap<string, LocalRun>) => {
    runsRef.current = next;
    setRuns(next);
  }, []);
  const selectRef = useRef<(id: string) => void>(() => {});

  useEffect(() => { currentRef.current = currentSessionId; }, [currentSessionId]);

  useEffect(() => {
    setSidebarCollapsedState(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    setSidebarCollapsedState(collapsed);
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await getSessions();
    // 对账：离开了的回答，服务端说做完了（或者起步宽限过了还没见过它）就收掉
    const now = Date.now();
    const byId = new Map(data.map((s) => [s.id, s]));
    const next = new Map(runsRef.current);
    let changed = false;
    for (const [id, run] of next) {
      const listed = byId.get(id);
      if (listed?.running) {
        if (run.seen) continue;
        next.set(id, { ...run, seen: true });
        changed = true;
      } else if (run.phase === 'detached' && (!listed || run.seen || now - run.since > RUN_GRACE_MS)) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) commitRuns(next);
    setSessions(data);
    setSessionsLoaded(true);
    // 在后台做完的对话（不是正看着的这段）：提示一下，点一下就过去
    const running = new Set([...data.filter((s) => s.running).map((s) => s.id), ...next.keys()]);
    const before = runningRef.current;
    runningRef.current = running;
    for (const id of before ?? []) {
      if (running.has(id) || id === currentRef.current || pendingDeletes.current.has(id)) continue;
      const session = data.find((s) => s.id === id);
      if (!session) continue;
      toast(`「${session.title || '新对话'}」有新回复`, {
        duration: 6000,
        action: { label: '查看', onClick: () => selectRef.current(id) },
      });
    }
    return data;
  }, [commitRuns]);

  const trackRun = useCallback((sessionId: string, phase: RunPhase, owner?: object) => {
    const current = runsRef.current;
    const prev = current.get(sessionId);
    if (phase !== 'live' && (!prev || (owner && prev.owner && prev.owner !== owner))) return;
    if (prev && prev.phase === phase && prev.owner === (owner ?? prev.owner)) return;
    const next = new Map(current);
    if (phase === 'end') next.delete(sessionId);
    else next.set(sessionId, { phase, since: prev?.since ?? Date.now(), seen: prev?.seen ?? false, owner: owner ?? prev?.owner });
    commitRuns(next);
  }, [commitRuns]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const visibleSessions = useMemo(
    () => sessions
      .filter((s) => !hidden.has(s.id))
      .map((s) => (!s.running && runs.has(s.id) ? { ...s, running: true } : s)),
    [hidden, runs, sessions],
  );
  // 本端还连着的回答自己会收尾，不用轮询；离开了的要靠列表看它做完没有
  const anyRunning = sessions.some((s) => s.running) || [...runs.values()].some((r) => r.phase === 'detached');

  // 有对话在后台回答：定时刷新列表，页面切回来时也刷新一次
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadSessions();
    }, RUNNING_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadSessions();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [anyRunning, loadSessions]);

  const newChat = useCallback(() => {
    setCurrentSessionId(null);
    setMobileOpen(false);
  }, []);

  const selectSession = useCallback((id: string) => {
    setCurrentSessionId(id);
    setMobileOpen(false);
  }, []);
  useEffect(() => { selectRef.current = selectSession; }, [selectSession]);

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
    trackRun,
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
