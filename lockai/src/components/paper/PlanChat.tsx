'use client';

import { useState, useCallback, useRef, useEffect, KeyboardEvent } from 'react';
import { Send, Loader2, FileText } from 'lucide-react';
import { StreamingMarkdown } from '@/components/chat/StreamingMarkdown';
import { createPaperSession, savePlanningMessages, getPlanningMessages } from '@/lib/api';
import { getAuthState } from '@/lib/auth';
import { useAppShell } from '@/components/AppShell';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

interface PlanMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PlanChatProps {
  /** paperId, topic, designContext */
  onStartGenerate: (paperId: string, topic: string, designContext: string) => void;
  /** 从侧边栏点击恢复的 paper_id */
  initialPaperId?: string | null;
}

export function PlanChat({ onStartGenerate, initialPaperId }: PlanChatProps) {
  const { loadPaperRecords, setCurrentPaperId, setPaperHeaderTitle, setPaperHeaderAction } = useAppShell();
  const [messages, setMessages] = useState<PlanMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [phase, setPhase] = useState<'hero' | 'chat'>('hero');
  const [paperId, setPaperId] = useState<string | null>(initialPaperId || null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionCreatedRef = useRef(!!initialPaperId);

  // Restore messages from backend when initialPaperId is provided (sidebar click)
  // Skip if this component created the session itself (sessionCreatedRef tracks that)
  const restoredIdRef = useRef<string | null>(initialPaperId || null);
  useEffect(() => {
    if (!initialPaperId) return;
    // Don't restore if we created this session ourselves
    if (sessionCreatedRef.current && initialPaperId === paperId) return;
    // Don't restore the same id twice
    if (initialPaperId === restoredIdRef.current && messages.length > 0) return;
    restoredIdRef.current = initialPaperId;
    setPaperId(initialPaperId);
    sessionCreatedRef.current = true;
    getPlanningMessages(initialPaperId).then(msgs => {
      if (msgs.length > 0) {
        setMessages(msgs as PlanMessage[]);
        setPhase('chat');
      }
    });
  }, [initialPaperId]); // eslint-disable-line react-hooks/exhaustive-deps

  // auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // auto-resize textarea
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }, []);

  // Create paper session on first AI output
  const ensureSession = useCallback(async (topic: string) => {
    if (sessionCreatedRef.current || paperId) return;
    sessionCreatedRef.current = true;
    const auth = getAuthState();
    const userId = auth.user?.id || 'anonymous';
    const id = await createPaperSession(topic, userId);
    if (id) {
      setPaperId(id);
      restoredIdRef.current = id; // prevent restore effect from firing
      // Defer sidebar update to avoid triggering effects during streaming
      setTimeout(() => {
        setCurrentPaperId(id);
        loadPaperRecords();
      }, 0);
    }
  }, [paperId, setCurrentPaperId, loadPaperRecords]);

  // Send message to planning chat
  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || isStreaming) return;

    const userMsg: PlanMessage = { role: 'user', content: msg };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setPhase('chat');
    setIsStreaming(true);

    if (inputRef.current) inputRef.current.style.height = 'auto';

    const controller = new AbortController();
    abortRef.current = controller;

    const assistantIdx = newMessages.length;
    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

    let accumulated = '';
    let sessionEnsured = false;
    // topic = first user message
    const topic = newMessages.find(m => m.role === 'user')?.content || msg;

    try {
      const resp = await fetch(`${API_BASE_URL}/api/paper/plan/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        setMessages(prev => {
          const copy = [...prev];
          copy[assistantIdx] = { role: 'assistant', content: '请求失败，请重试' };
          return copy;
        });
        setIsStreaming(false);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const block of events) {
          if (!block.trim()) continue;
          const lines = block.split('\n');
          let eventType = '';
          let dataLine = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventType = line.slice(7);
            else if (line.startsWith('data: ')) dataLine = line.slice(6);
          }
          if (!eventType || !dataLine) continue;
          try {
            const data = JSON.parse(dataLine);
            if (eventType === 'content' && data.content) {
              accumulated += data.content;
              // Create session on first content chunk
              if (!sessionEnsured) {
                sessionEnsured = true;
                ensureSession(topic);
              }
              setMessages(prev => {
                const copy = [...prev];
                copy[assistantIdx] = { role: 'assistant', content: accumulated };
                return copy;
              });
            }
          } catch { /* ignore */ }
        }

        if (done) break;
      }
      reader.releaseLock();
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setMessages(prev => {
        const copy = [...prev];
        copy[assistantIdx] = { role: 'assistant', content: accumulated || '连接中断' };
        return copy;
      });
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming, messages, ensureSession]);

  // Save messages to backend whenever streaming finishes and we have a paperId
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && paperId && messages.length > 0) {
      savePlanningMessages(paperId, messages);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, paperId, messages]);

  const handleHeroKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const handleChatKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  const handleStartGenerate = useCallback(() => {
    if (isStreaming || !paperId) return;
    const firstUser = messages.find(m => m.role === 'user');
    const topic = firstUser?.content || '';
    const designContext = messages
      .map(m => `${m.role === 'user' ? '用户' : 'AI'}：${m.content}`)
      .join('\n\n');
    onStartGenerate(paperId, topic, designContext);
  }, [messages, isStreaming, paperId, onStartGenerate]);

  const canGenerate = paperId && !isStreaming;
  const rawTopic = messages.find(m => m.role === 'user')?.content?.trim() || '论文规划';
  const planTitle = rawTopic.length > 30 ? `${rawTopic.slice(0, 30)}...` : rawTopic;

  useEffect(() => {
    if (phase !== 'chat') {
      setPaperHeaderTitle('');
      setPaperHeaderAction(null);
      return;
    }

    setPaperHeaderTitle(planTitle);
    if (paperId) {
      setPaperHeaderAction(
        <button
          onClick={handleStartGenerate}
          disabled={!canGenerate}
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-xl border border-border bg-background text-foreground text-sm font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          aria-label="开始生成论文"
        >
          <FileText className="w-4 h-4" />
          开始生成
        </button>
      );
    } else {
      setPaperHeaderAction(null);
    }

    return () => {
      setPaperHeaderTitle('');
      setPaperHeaderAction(null);
    };
  }, [phase, planTitle, paperId, canGenerate, handleStartGenerate, setPaperHeaderTitle, setPaperHeaderAction]);

  /* ======== HERO PHASE ======== */
  if (phase === 'hero') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-2xl mx-auto animate-fade-in">
            <div className="text-center mb-8">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 text-primary mb-4">
                <FileText className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold text-foreground mb-2">
                一句话，完成论文
              </h2>
              <p className="text-sm text-muted-foreground">
                输入研究主题，AI 自动完成文献检索、结构规划、内容撰写与精美排版
              </p>
            </div>

            <div className="group/hero relative rounded-2xl bg-card border border-border transition-shadow duration-200 hover:shadow-md focus-within:shadow-md focus-within:border-primary/50">
              <div className="flex items-center gap-3 px-4 py-3">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleHeroKeyDown}
                  placeholder="输入研究主题，例如：基于 Transformer 的图像分类方法综述"
                  className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none text-base"
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={!input.trim() || isStreaming}
                  className="shrink-0 w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 cursor-pointer"
                  aria-label="开始"
                >
                  {isStreaming ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center mt-3">
              LockAI 可能会出错，请核实重要信息。仅供日常课程作业的辅助参考，不可用于正式学术发表
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* ======== CHAT PHASE ======== */
  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg, i) => {
            const isUser = msg.role === 'user';
            const isLastAssistant = !isUser && i === messages.length - 1;
            const showCursor = isLastAssistant && isStreaming;
            const isAssistantLoading = !isUser && showCursor && !msg.content.trim();

            return (
              <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`
                    max-w-[80%] rounded-2xl px-4 py-3 text-sm
                    ${isUser
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card border border-border text-foreground'
                    }
                  `}
                >
                  {isUser ? (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  ) : isAssistantLoading ? (
                    <div className="min-w-56">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        <span className="text-sm">正在构思论文方案</span>
                        <span className="flex gap-1">
                          <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        正在分析主题并整理章节结构...
                      </p>
                    </div>
                  ) : (
                    <StreamingMarkdown content={msg.content} showCursor={showCursor} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Input bar — disabled: coming soon */}
      <div className="shrink-0 px-4 pb-3">
        <div className="max-w-3xl mx-auto">
          <div className="group/chat relative flex items-end gap-2 rounded-2xl border border-border bg-card px-4 py-2.5 transition-shadow duration-200 hover:shadow-md focus-within:shadow-md focus-within:border-primary/50">
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleChatKeyDown}
              placeholder="继续讨论..."
              rows={1}
              disabled={isStreaming}
              className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground outline-none text-sm resize-none leading-relaxed disabled:opacity-50"
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || isStreaming}
              className="shrink-0 p-2 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              aria-label="发送"
            >
              {isStreaming ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-2">
            LockAI 可能会出错，请核实重要信息。仅供日常课程作业的辅助参考，不可用于正式学术发表
          </p>
        </div>
      </div>
    </div>
  );
}
