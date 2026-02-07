'use client';

import { useState, useCallback, useEffect, useTransition, createContext, useContext } from 'react';
import { usePathname } from 'next/navigation';
import { ChatSession, PaperRecord } from '@/types';
import { Sidebar } from '@/components/chat/Sidebar';
import { SettingsModal } from '@/components/SettingsModal';
import { getSessions, getSession } from '@/lib/chat-history';
import { listPapers, deletePaper } from '@/lib/api';
import { getAuthState } from '@/lib/auth';

interface AppShellContextType {
  sessions: ChatSession[];
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  loadSessions: () => Promise<ChatSession[]>;
  paperRecords: PaperRecord[];
  loadPaperRecords: () => Promise<void>;
  currentPaperId: string | null;
  setCurrentPaperId: (id: string | null) => void;
  paperNewProjectTick: number;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

const AppShellContext = createContext<AppShellContextType | null>(null);

export function useAppShell() {
  const context = useContext(AppShellContext);
  if (!context) {
    throw new Error('useAppShell must be used within AppShell');
  }
  return context;
}

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [paperRecords, setPaperRecords] = useState<PaperRecord[]>([]);
  const [currentPaperId, setCurrentPaperId] = useState<string | null>(null);
  const [paperNewProjectTick, setPaperNewProjectTick] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const isChat = pathname === '/chat';
  const isPaper = pathname === '/paper';
  const currentSessionTitle = isChat
    ? sessions.find(s => s.id === currentSessionId)?.title || '新对话'
    : '';

  const loadSessions = useCallback(async () => {
    const data = await getSessions();
    startTransition(() => {
      setSessions(data);
    });
    return data;
  }, []);

  const loadPaperRecords = useCallback(async () => {
    const auth = getAuthState();
    const userId = auth.user?.id;
    if (!userId) return;
    const records = await listPapers(userId);
    startTransition(() => {
      setPaperRecords(records);
    });
  }, []);

  // 初始化加载会话
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Paper 页面加载论文记录
  useEffect(() => {
    if (isPaper) {
      loadPaperRecords();
    }
  }, [isPaper, loadPaperRecords]);

  const handleSelectSession = useCallback(async (sessionId: string) => {
    if (isPaper) {
      setCurrentPaperId(sessionId);
    } else {
      setCurrentSessionId(sessionId);
    }
  }, [isPaper]);

  const handleNewChat = useCallback(() => {
    if (isChat) {
      setCurrentSessionId(null);
    }
    if (isPaper) {
      setCurrentPaperId(null);
      setPaperNewProjectTick(tick => tick + 1);
    }
  }, [isChat, isPaper]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (isPaper) {
      await deletePaper(sessionId);
      if (sessionId === currentPaperId) {
        setCurrentPaperId(null);
      }
      loadPaperRecords();
    } else {
      if (sessionId === currentSessionId) {
        setCurrentSessionId(null);
      }
      loadSessions();
    }
  }, [isPaper, loadSessions, loadPaperRecords, currentSessionId, currentPaperId, setCurrentPaperId]);

  const contextValue: AppShellContextType = {
    sessions,
    currentSessionId,
    setCurrentSessionId,
    loadSessions,
    paperRecords,
    loadPaperRecords,
    currentPaperId,
    setCurrentPaperId,
    paperNewProjectTick,
    sidebarCollapsed,
    setSidebarCollapsed,
  };

  return (
    <AppShellContext.Provider value={contextValue}>
      <Sidebar
        sessions={isChat ? sessions : []}
        paperRecords={isPaper ? paperRecords : []}
        currentSessionId={isPaper ? currentPaperId : (isChat ? currentSessionId : null)}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        isPaper={isPaper}
      />

      <div
        className={`
          min-h-screen transition-[margin] duration-300
          ${sidebarCollapsed ? 'ml-16' : 'ml-72'}
        `}
      >
        <div
          className="fixed top-4 left-4 right-4 z-10 transition-[margin] duration-300"
          style={{ marginLeft: sidebarCollapsed ? '64px' : '288px' }}
        >
          <div className="relative flex items-center justify-between">
            <div className="text-xl text-foreground logo-text">LockAI</div>
            {isChat && (
              <div className="absolute left-1/2 -translate-x-1/2 text-sm text-muted-foreground truncate max-w-[50%]">
                {currentSessionTitle}
              </div>
            )}
            <div className="w-16" />
          </div>
        </div>
        {children}
      </div>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </AppShellContext.Provider>
  );
}
