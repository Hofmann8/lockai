'use client';

import { useState, useCallback, useEffect, useTransition, createContext, useContext } from 'react';
import { usePathname } from 'next/navigation';
import { ChatSession } from '@/types';
import { Sidebar } from '@/components/chat/Sidebar';
import { SettingsModal } from '@/components/SettingsModal';
import { getSessions, getSession } from '@/lib/chat-history';

interface AppShellContextType {
  sessions: ChatSession[];
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  loadSessions: () => Promise<ChatSession[]>;
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const isChat = pathname === '/chat';
  const isPaper = pathname === '/paper';

  const loadSessions = useCallback(async () => {
    const data = await getSessions();
    startTransition(() => {
      setSessions(data);
    });
    return data;
  }, []);

  // 初始化加载会话
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleSelectSession = useCallback(async (sessionId: string) => {
    setCurrentSessionId(sessionId);
  }, []);

  const handleNewChat = useCallback(() => {
    if (isChat) {
      setCurrentSessionId(null);
    }
    // Paper 页面的新项目逻辑由 Paper 组件处理
  }, [isChat]);

  const handleDeleteSession = useCallback(() => {
    loadSessions();
  }, [loadSessions]);

  const contextValue: AppShellContextType = {
    sessions,
    currentSessionId,
    setCurrentSessionId,
    loadSessions,
    sidebarCollapsed,
    setSidebarCollapsed,
  };

  return (
    <AppShellContext.Provider value={contextValue}>
      <Sidebar
        sessions={isChat ? sessions : []}
        currentSessionId={isChat ? currentSessionId : null}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div
        className={`
          min-h-screen transition-[margin] duration-300
          ${sidebarCollapsed ? 'ml-16' : 'ml-72'}
        `}
      >
        <div className="fixed top-4 left-4 text-lg font-semibold text-foreground z-10 transition-[margin] duration-300"
          style={{ marginLeft: sidebarCollapsed ? '64px' : '288px' }}
        >
          LockAI
        </div>
        {children}
      </div>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </AppShellContext.Provider>
  );
}
