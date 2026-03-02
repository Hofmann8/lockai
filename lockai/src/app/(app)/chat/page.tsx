'use client';

import { useState, useCallback, useEffect } from 'react';
import { ChatMessage, ChatState } from '@/types';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput } from '@/components/chat/MessageInput';
import { sendChatMessageStream, StreamEvent, generateSessionTitle } from '@/lib/api';
import { getSession, createSession, addMessage, truncateMessages } from '@/lib/chat-history';
import { getAuthState } from '@/lib/auth';
import { useAppShell } from '@/components/AppShell';
import { EffectiveAIRole } from '@/lib/settings';

const initialState: ChatState = {
  messages: [],
  isLoading: false,
  error: null,
};

export default function ChatPage() {
  const { currentSessionId, setCurrentSessionId, loadSessions, sessions } = useAppShell();
  
  const [state, setState] = useState<ChatState>(initialState);
  const [streamingContent, setStreamingContent] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchKeywords, setSearchKeywords] = useState<string[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingPrompt, setDrawingPrompt] = useState('');
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [isInputActive, setIsInputActive] = useState(false);
  const [recallText, setRecallText] = useState<string | undefined>(undefined);
  const [recallTick, setRecallTick] = useState(0);

  // 加载当前会话消息
  useEffect(() => {
    if (currentSessionId) {
      getSession(currentSessionId).then(session => {
        if (session) {
          setState(prev => ({ ...prev, messages: session.messages }));
        }
      });
    } else {
      setState(prev => ({ ...prev, messages: [], isLoading: false, error: null }));
    }
  }, [currentSessionId]);

  const handleSendMessage = useCallback(async (content: string, effectiveRole: EffectiveAIRole) => {
    if (!content.trim() || state.isLoading) return;

    let sessionId = currentSessionId;
    let isNewSession = false;
    if (!sessionId) {
      const session = await createSession();
      if (!session) {
        setState(prev => ({ ...prev, error: '创建会话失败' }));
        return;
      }
      sessionId = session.id;
      isNewSession = true;
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

    await addMessage(sessionId, userMessage);
    if (isNewSession) {
      setCurrentSessionId(sessionId);
    }
    await loadSessions();

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
        ai_role: effectiveRole,
        user_id: getAuthState().user?.id,
        session_id: sessionId,
      },
      handleEvent
    );

    if (savedAssistantContent) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const msgToSave: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: savedAssistantContent,
        timestamp: new Date(),
      };
      await addMessage(sessionId, msgToSave);

      // 检查 session 是否还没有生成过标题（默认"新对话"）
      const currentSession = sessions.find(s => s.id === sessionId);
      if (!currentSession || currentSession.title === '新对话') {
        const firstUserMsg = state.messages.find(m => m.role === 'user')?.content || content.trim();
        const title = await generateSessionTitle(sessionId, firstUserMsg, savedAssistantContent);
        if (title) {
          await loadSessions();
        }
      }
    }
  }, [state.messages, state.isLoading, currentSessionId, setCurrentSessionId, loadSessions]);

  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  const handleRecall = useCallback(async (message: ChatMessage) => {
    if (!currentSessionId) return;
    // 截断后端数据库
    await truncateMessages(currentSessionId, message.id);
    // 截断前端状态：保留该消息之前的消息
    setState(prev => {
      const idx = prev.messages.findIndex(m => m.id === message.id);
      return {
        ...prev,
        messages: idx > 0 ? prev.messages.slice(0, idx) : [],
      };
    });
    // 把消息内容放回输入框
    setRecallText(message.content);
    setRecallTick(t => t + 1);
  }, [currentSessionId]);

  return (
    <div className="flex flex-col h-screen pt-12">
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
            onRecall={handleRecall}
          />
        </div>
      </div>

      <div className="relative max-w-4xl mx-auto w-full px-4 pb-4">
        <div className="absolute -top-4 left-0 right-0 h-4 bg-gradient-to-t from-background to-transparent pointer-events-none" />
        <MessageInput
          onSend={handleSendMessage}
          disabled={state.isLoading}
          onActiveChange={setIsInputActive}
          defaultValue={recallText}
          key={recallTick}
        />
        <p className="text-xs text-muted-foreground text-center mt-3">
          LockAI 可能会出错，请核实重要信息
        </p>
      </div>
    </div>
  );
}
