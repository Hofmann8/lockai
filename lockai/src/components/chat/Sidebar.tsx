'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { Plus, MessageSquare, Trash2, ChevronLeft, LogOut, Settings, FileText, Check, X } from 'lucide-react';
import { ChatSession, AuthState, PaperRecord } from '@/types';
import { deleteSession } from '@/lib/chat-history';
import { getAuthState, logout, fetchUserAvatar, getSignedUrlExpiry, isSignedUrlExpired, updateAvatarUrl } from '@/lib/auth';

interface SidebarProps {
  sessions: ChatSession[];
  paperRecords: PaperRecord[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isPaper?: boolean;
}

const navItems = [
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/paper', label: 'Paper', icon: FileText },
];

export function Sidebar({
  sessions,
  paperRecords,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onOpenSettings,
  isCollapsed,
  onToggleCollapse,
  isPaper = false,
}: SidebarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [user] = useState<AuthState['user']>(() => getAuthState().user);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() => getAuthState().user?.avatarUrl || null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const avatarRefreshingRef = useRef(false);
  const avatarErrorHandledRef = useRef<string | null>(null);

  const refreshAvatar = useCallback(async (force = false) => {
    if (avatarRefreshingRef.current) return;
    if (!force && avatarUrl && !isSignedUrlExpired(avatarUrl)) return;

    avatarRefreshingRef.current = true;
    try {
      const url = await fetchUserAvatar('avatarmd');
      if (url) {
        avatarErrorHandledRef.current = null;
        setAvatarUrl(url);
        updateAvatarUrl(url);
      } else if (force && avatarUrl) {
        // 强制刷新失败时回退到默认头像，避免持续 403。
        setAvatarUrl(null);
        updateAvatarUrl(null);
      }
    } finally {
      avatarRefreshingRef.current = false;
    }
  }, [avatarUrl]);

  // 初始化和状态变化时，按需刷新头像签名 URL。
  useEffect(() => {
    void refreshAvatar(false);
  }, [refreshAvatar]);

  // 在过期前 5 分钟自动续签，避免用户使用中突然 403。
  useEffect(() => {
    if (!avatarUrl) return;
    const expiresAt = getSignedUrlExpiry(avatarUrl);
    if (!expiresAt) return;

    const renewAt = expiresAt - 5 * 60 * 1000;
    const delay = Math.max(0, renewAt - Date.now());
    const timer = window.setTimeout(() => {
      void refreshAvatar(true);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [avatarUrl, refreshAvatar]);

  const handleAvatarError = useCallback(() => {
    if (!avatarUrl) return;

    // 同一 URL 只重试一次，防止加载失败循环。
    if (avatarErrorHandledRef.current === avatarUrl) {
      setAvatarUrl(null);
      updateAvatarUrl(null);
      return;
    }

    avatarErrorHandledRef.current = avatarUrl;
    void refreshAvatar(true);
  }, [avatarUrl, refreshAvatar]);

  const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setConfirmDeleteId(sessionId);
  };

  const handleConfirmDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (!isPaper) {
      await deleteSession(sessionId);
    }
    onDeleteSession(sessionId);
    setConfirmDeleteId(null);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
  };

  const handleLogout = () => {
    logout();
    router.push('/');
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const groupedSessions = sessions.reduce((groups, session) => {
    const dateKey = formatDate(session.updatedAt);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(session);
    return groups;
  }, {} as Record<string, ChatSession[]>);

  return (
    <aside
      className={`
        fixed left-0 top-0 h-full z-40
        bg-card/95 backdrop-blur-xl border-r border-border
        transition-[width] duration-300 ease-in-out overflow-hidden
        ${isCollapsed ? 'w-16' : 'w-72'}
      `}
    >
      {/* Toggle Button - 固定位置，不随状态变化 */}
      <div className="absolute top-0 left-0 w-16 flex items-center justify-center p-4 z-10">
        <button
          onClick={onToggleCollapse}
          className="p-2 rounded-lg hover:bg-muted transition-colors cursor-pointer"
          aria-label={isCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <ChevronLeft className={`w-5 h-5 transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* 展开状态内容 - 固定宽度 */}
      <div className={`absolute inset-0 w-72 flex flex-col transition-opacity duration-200 ${isCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
        {/* Header placeholder */}
        <div className="h-[73px] border-b border-border" />

        {/* Navigation */}
        <div className="p-3 border-b border-border">
          <div className="flex gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`
                    flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-sm font-medium
                    transition-colors cursor-pointer
                    ${isActive 
                      ? 'bg-primary text-primary-foreground' 
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }
                  `}
                >
                  <Icon className="w-4 h-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* New Chat / New Project Button */}
        <div className="p-3">
          <button
            onClick={onNewChat}
            className="flex items-center gap-3 w-full p-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-all cursor-pointer"
          >
            <Plus className="w-5 h-5 shrink-0" />
            <span>{isPaper ? '新项目' : '新对话'}</span>
          </button>
        </div>

        {/* Sessions / Paper Records List */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {isPaper ? (
            /* Paper Records */
            paperRecords.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">暂无论文记录</div>
            ) : (
              <div className="space-y-1">
                {paperRecords.map((record) => (
                  <div
                    key={record.id}
                    onClick={() => confirmDeleteId !== record.id && onSelectSession(record.id)}
                    className={`
                      group flex items-center gap-3 w-full p-3 rounded-xl text-left
                      transition-colors cursor-pointer
                      ${record.id === currentSessionId
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted text-foreground'
                      }
                    `}
                  >
                    {confirmDeleteId === record.id ? (
                      <>
                        <span className="flex-1 text-sm text-destructive">确认删除？</span>
                        <button
                          onClick={(e) => handleConfirmDelete(e, record.id)}
                          className="p-1 rounded hover:bg-destructive/20 text-destructive transition-all cursor-pointer"
                          aria-label="确认删除"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={handleCancelDelete}
                          className="p-1 rounded hover:bg-muted text-muted-foreground transition-all cursor-pointer"
                          aria-label="取消"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <FileText className="w-4 h-4 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="block truncate text-sm">{record.topic}</span>
                          <span className="block text-xs text-muted-foreground">
                            {record.status === 'completed' ? '已完成' : record.status}
                            {record.created_at && ` · ${new Date(record.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}`}
                          </span>
                        </div>
                        <button
                          onClick={(e) => handleDeleteClick(e, record.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all cursor-pointer"
                          aria-label="删除论文"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )
          ) : (
            /* Chat Sessions */
            Object.entries(groupedSessions).map(([dateKey, dateSessions]) => (
            <div key={dateKey} className="mb-4">
              <div className="text-xs text-muted-foreground px-2 py-1 font-medium">
                {dateKey}
              </div>
              <div className="space-y-1">
                {dateSessions.map((session) => (
                  <div
                    key={session.id}
                    onClick={() => confirmDeleteId !== session.id && onSelectSession(session.id)}
                    className={`
                      group flex items-center gap-3 w-full p-3 rounded-xl text-left
                      transition-colors cursor-pointer
                      ${session.id === currentSessionId
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted text-foreground'
                      }
                    `}
                  >
                    {confirmDeleteId === session.id ? (
                      <>
                        <span className="flex-1 text-sm text-destructive">确认删除？</span>
                        <button
                          onClick={(e) => handleConfirmDelete(e, session.id)}
                          className="p-1 rounded hover:bg-destructive/20 text-destructive transition-all cursor-pointer"
                          aria-label="确认删除"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={handleCancelDelete}
                          className="p-1 rounded hover:bg-muted text-muted-foreground transition-all cursor-pointer"
                          aria-label="取消"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <MessageSquare className="w-4 h-4 shrink-0" />
                        <span className="flex-1 truncate text-sm">{session.title}</span>
                        <button
                          onClick={(e) => handleDeleteClick(e, session.id)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all cursor-pointer"
                          aria-label="删除对话"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
          )}
        </div>

        {/* User Info & Actions */}
        <div className="border-t border-border p-3 space-y-2">
          <div className="flex items-center gap-3 p-2 rounded-xl bg-muted/50">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={user?.name || '用户头像'}
                width={40}
                height={40}
                className="w-10 h-10 rounded-full object-cover shrink-0"
                onError={handleAvatarError}
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold shrink-0">
                {user?.name?.charAt(0).toUpperCase() || 'U'}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="font-medium text-foreground truncate">{user?.name || '用户'}</div>
              <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onOpenSettings}
              className="flex-1 flex items-center justify-center gap-2 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <Settings className="w-4 h-4" />
              <span className="text-sm">设置</span>
            </button>
            <button
              onClick={handleLogout}
              className="flex-1 flex items-center justify-center gap-2 p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span className="text-sm">退出</span>
            </button>
          </div>
        </div>
      </div>

      {/* 收起状态内容 - 固定宽度 */}
      <div className={`absolute inset-0 w-16 flex flex-col transition-opacity duration-200 ${isCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        {/* Header placeholder */}
        <div className="h-[73px] border-b border-border" />

        {/* Navigation */}
        <div className="p-3 border-b border-border space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link
                key={`collapsed-${item.href}`}
                href={item.href}
                className={`
                  flex items-center justify-center p-2 rounded-xl
                  transition-colors cursor-pointer
                  ${isActive 
                    ? 'bg-primary text-primary-foreground' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }
                `}
                title={item.label}
              >
                <Icon className="w-5 h-5" />
              </Link>
            );
          })}
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <button
            onClick={onNewChat}
            className="flex items-center justify-center w-full p-3 rounded-xl bg-primary text-primary-foreground font-medium hover:opacity-90 transition-all cursor-pointer"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {sessions.slice(0, 8).map((session) => (
            <button
              key={`collapsed-session-${session.id}`}
              onClick={() => onSelectSession(session.id)}
              className={`
                flex items-center justify-center w-full p-3 rounded-xl mb-1
                transition-colors cursor-pointer
                ${session.id === currentSessionId
                  ? 'bg-primary/10 text-primary'
                  : 'hover:bg-muted text-muted-foreground'
                }
              `}
              title={session.title}
            >
              <MessageSquare className="w-5 h-5" />
            </button>
          ))}
        </div>

        {/* User Info & Actions */}
        <div className="border-t border-border p-3 space-y-2">
          <div className="flex justify-center">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={user?.name || '用户头像'}
                width={40}
                height={40}
                className="w-10 h-10 rounded-full object-cover"
                onError={handleAvatarError}
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-primary font-semibold">
                {user?.name?.charAt(0).toUpperCase() || 'U'}
              </div>
            )}
          </div>
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center justify-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            title="设置"
          >
            <Settings className="w-5 h-5" />
          </button>
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            title="退出"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
