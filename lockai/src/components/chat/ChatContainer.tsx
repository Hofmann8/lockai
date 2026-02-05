'use client';

import { useState, useCallback, useEffect, useTransition } from 'react';
import { ChatMessage, ChatState, ChatSession } from '@/types';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { Sidebar } from './Sidebar';
import { sendChatMessageStream, StreamEvent, generateSessionTitle } from '@/lib/api';
import { getSessions, getSession, createSession, addMessage } from '@/lib/chat-history';
import { getAuthState } from '@/lib/auth';
import { SettingsModal } from '@/components/SettingsModal';

const initialState: ChatState = {
  messages: [],
  isLoading: false,
  error: null,
};

export function ChatContainer() {
  const [state, setState] = useState<ChatState>(initialState);
  const [streamingContent, setStreamingContent] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchKeywords, setSearchKeywords] = useState<string[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPrompt, setDrawingPrompt] = useState('');
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInputActive, setIsInputActive] = useState(false);
  const [isPending, startTransition] = useTransition();

  // 加载会话列表
  const loadSessions = useCallback(async () => {
    const data = await getSessions();
    startTransition(() => {
      setSessions(data);
    });
    return data;
  }, []);

  // 初始化 - 先显示 UI，再加载数据
  useEffect(() => {
    // 立即标记为已初始化，先显示空白 UI
    setIsInitialized(true);
    
    const init = async () => {
      const sessionList = await getSessions();
      startTransition(() => {
        setSessions(sessionList);
      });
      
      if (sessionList.length > 0) {
        const session = await getSession(sessionList[0].id);
        if (session) {
          startTransition(() => {
            setCurrentSession(session);
            setState(prev => ({ ...prev, messages: session.messages }));
          });
        }
      }
    };
    init();
  }, []);

  const handleSelectSession = useCallback(async (sessionId: string) => {
    const session = await getSession(sessionId);
    if (session) {
      setCurrentSession(session);
      setState(prev => ({ ...prev, messages: session.messages, error: null }));
    }
  }, []);

  const handleNewChat = useCallback(() => {
    // 如果已经在"新对话"状态（没有当前会话），不做任何事
    if (!currentSession) {
      return;
    }
    // 退出当前对话，进入"新对话"状态
    setCurrentSession(null);
    setState(initialState);
  }, [currentSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    await loadSessions();
    if (currentSession?.id === sessionId) {
      const newSessions = sessions.filter(s => s.id !== sessionId);
      if (newSessions.length > 0) {
        await handleSelectSession(newSessions[0].id);
      } else {
        await handleNewChat();
      }
    }
  }, [currentSession, sessions, loadSessions, handleSelectSession, handleNewChat]);

  const handleSendMessage = useCallback(async (content: string) => {
    if (!content.trim() || state.isLoading) return;

    // 如果没有当前会话，先创建一个
    let session = currentSession;
    if (!session) {
      session = await createSession();
      if (!session) {
        setState(prev => ({ ...prev, error: '创建会话失败' }));
        return;
      }
      setCurrentSession(session);
      await loadSessions(); // 刷新列表显示新会话
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content.trim(),
      timestamp: new Date(),
    };

    const newMessages = [...state.messages, userMessage];
    setState(prev => ({
      ...prev,
      messages: newMessages,
      isLoading: true,
      error: null,
    }));

    // 保存用户消息到数据库
    await addMessage(session.id, userMessage);
    await loadSessions(); // 刷新列表（标题可能更新了）

    setStreamingContent('');
    setIsSearching(false);
    setSearchQuery('');
    setSearchKeywords([]);
    setIsDrawing(false);
    setDrawingPrompt('');
    setGeneratedImages([]);

    let fullContent = '';
    const images: string[] = [];
    let savedAssistantContent = '';

    const handleEvent = (event: StreamEvent) => {
      console.log('[Chat] 收到事件:', event.type);
      switch (event.type) {
        case 'content':
          fullContent += event.content || '';
          setStreamingContent(fullContent);
          if (event.content && event.content.trim()) {
            setIsSearching(false);
            setSearchKeywords([]);
            setIsDrawing(false);
          }
          break;
        
        case 'searching':
          setIsSearching(true);
          setSearchQuery(event.query || '');
          setSearchKeywords([]);
          break;
        
        case 'search_progress':
          if (event.keywords) {
            setSearchKeywords(prev => {
              const newKeywords = [...prev];
              for (const kw of event.keywords!) {
                if (!newKeywords.includes(kw)) {
                  newKeywords.push(kw);
                }
              }
              return newKeywords.slice(-6);
            });
          }
          break;
        
        case 'search_complete':
          break;
        
        case 'drawing':
          setIsDrawing(true);
          setDrawingPrompt(event.prompt || '');
          break;
        
        case 'image':
          if (event.image) {
            images.push(event.image);
            setGeneratedImages([...images]);
            setIsDrawing(false);
          }
          break;
        
        case 'error':
          setState(prev => ({
            ...prev,
            isLoading: false,
            error: event.error || '发送消息失败',
          }));
          setIsSearching(false);
          setSearchKeywords([]);
          setIsDrawing(false);
          break;
        
        case 'done':
          console.log('[Chat] done 事件触发, fullContent 长度:', fullContent.length);
          let finalContent = fullContent;
          if (images.length > 0) {
            finalContent += '\n\n' + images.map(img => `![生成的图片](${img})`).join('\n\n');
          }
          
          savedAssistantContent = finalContent;
          
          const assistantMessage: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: finalContent,
            timestamp: new Date(),
          };

          setState(prev => ({
            ...prev,
            messages: [...newMessages, assistantMessage],
            isLoading: false,
            error: null,
          }));
          
          setStreamingContent('');
          setIsSearching(false);
          setSearchQuery('');
          setSearchKeywords([]);
          setIsDrawing(false);
          setDrawingPrompt('');
          setGeneratedImages([]);
          break;
      }
    };

    await sendChatMessageStream(
      {
        message: content.trim(),
        history: state.messages,
        user_id: getAuthState().user?.id,
        session_id: session!.id,
      },
      handleEvent
    );
    
    // 流结束后保存助手消息（延迟执行确保连接释放）
    if (savedAssistantContent) {
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('[Chat] 流结束，保存助手消息');
      const msgToSave: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: savedAssistantContent,
        timestamp: new Date(),
      };
      const success = await addMessage(session!.id, msgToSave);
      console.log('[Chat] addMessage 结果:', success);
      
      // 如果是新会话的第一次问答，用 AI 生成标题
      if (newMessages.length === 1) {
        console.log('[Chat] 新会话第一次问答，生成标题');
        const title = await generateSessionTitle(session!.id, content.trim(), savedAssistantContent);
        console.log('[Chat] 生成标题结果:', title);
        if (title) {
          await loadSessions();
        }
      }
    }
  }, [state.messages, state.isLoading, currentSession, loadSessions]);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  return (
    <>
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSession?.id || null}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      
      <div 
        className={`
          flex flex-col h-screen transition-all duration-300 relative
          ${sidebarCollapsed ? 'ml-16' : 'ml-72'}
        `}
      >
        <div className="absolute top-4 left-4 text-lg font-semibold text-foreground z-10">
          LockAI
        </div>
        {state.error && (
          <div className="mx-4 mt-4 p-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive flex items-center justify-between animate-slide-up">
            <span>{state.error}</span>
            <button
              onClick={clearError}
              className="ml-4 text-sm underline hover:no-underline cursor-pointer"
            >
              关闭
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="h-full max-w-4xl mx-auto">
            <MessageList 
              messages={state.messages} 
              isLoading={state.isLoading}
              streamingContent={streamingContent}
              isSearching={isSearching}
              searchQuery={searchQuery}
              searchKeywords={searchKeywords}
              isDrawing={isDrawing}
              drawingPrompt={drawingPrompt}
              generatedImages={generatedImages}
              isInputActive={isInputActive}
            />
          </div>
        </div>

        <div className="relative max-w-4xl mx-auto w-full px-4 pb-4">
          <div className="absolute -top-4 left-0 right-0 h-4 bg-gradient-to-t from-background to-transparent pointer-events-none" />
          <MessageInput
            onSend={handleSendMessage}
            disabled={state.isLoading}
            onActiveChange={setIsInputActive}
          />
          <p className="text-xs text-muted-foreground text-center mt-3">
            LockAI 可能会出错，请核实重要信息
          </p>
        </div>
      </div>
      
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
}
