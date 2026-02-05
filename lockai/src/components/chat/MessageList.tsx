'use client';

import { useRef, useEffect, useState } from 'react';
import { ChatMessage } from '@/types';
import { Message } from './Message';
import { StreamingMarkdown } from './StreamingMarkdown';
import { Loader2, Search, Palette } from 'lucide-react';
import { getCurrentRoleName, onSettingsChange, getSettings, isDeepThinkingMode } from '@/lib/settings';
import Lottie, { LottieRefCurrentProps } from 'lottie-react';
import lockAnimation from '../../../public/Unlock.json';
import Image from 'next/image';
import { useTheme } from '@/lib/theme';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingContent?: string;
  isSearching?: boolean;
  searchQuery?: string;
  searchKeywords?: string[];
  isDrawing?: boolean;
  drawingPrompt?: string;
  generatedImages?: string[];
  isInputActive?: boolean;
}

export function MessageList({ 
  messages, 
  isLoading, 
  streamingContent = '',
  isSearching = false,
  searchQuery = '',
  searchKeywords = [],
  isDrawing = false,
  drawingPrompt = '',
  generatedImages = [],
  isInputActive = false
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lottieRef = useRef<LottieRefCurrentProps>(null);
  const [roleName, setRoleName] = useState('小锁老师');
  const [currentRole, setCurrentRole] = useState(getSettings().aiRole);
  const [isDeepThinking, setIsDeepThinking] = useState(isDeepThinkingMode());
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const thinkingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const prevInputActive = useRef(isInputActive);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    setRoleName(getCurrentRoleName());
    setCurrentRole(getSettings().aiRole);
    setIsDeepThinking(isDeepThinkingMode());
    return onSettingsChange((settings) => {
      setRoleName(getCurrentRoleName());
      setCurrentRole(settings.aiRole);
      setIsDeepThinking(isDeepThinkingMode());
    });
  }, []);

  // 深度思考模式计时器
  useEffect(() => {
    if (isLoading && !streamingContent && !isSearching && isDeepThinking) {
      setThinkingSeconds(0);
      thinkingTimerRef.current = setInterval(() => {
        setThinkingSeconds(prev => prev + 1);
      }, 1000);
    } else {
      if (thinkingTimerRef.current) {
        clearInterval(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      setThinkingSeconds(0);
    }
    
    return () => {
      if (thinkingTimerRef.current) {
        clearInterval(thinkingTimerRef.current);
      }
    };
  }, [isLoading, streamingContent, isSearching, isDeepThinking]);

  // 控制 Lottie 动画播放方向
  useEffect(() => {
    if (!lottieRef.current) return;
    
    if (isInputActive && !prevInputActive.current) {
      // 从锁着到开锁：播放 45→69
      lottieRef.current.playSegments([45, 69], true);
    } else if (!isInputActive && prevInputActive.current) {
      // 从开锁到锁着：反向播放 69→45
      lottieRef.current.setDirection(-1);
      lottieRef.current.playSegments([69, 45], true);
    }
    
    prevInputActive.current = isInputActive;
  }, [isInputActive]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading, streamingContent, generatedImages]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground animate-fade-in">
        <div className="w-20 h-20 mb-4 opacity-50">
          <Lottie
            lottieRef={lottieRef}
            animationData={lockAnimation}
            loop={false}
            autoplay={false}
          />
        </div>
        <p className="text-lg font-medium">开始与{roleName}对话</p>
        <p className="text-sm mt-1">输入消息开始聊天</p>
      </div>
    );
  }

  return (
    <div className="px-4 pt-6 pb-6 space-y-6">
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}

      {/* 流式输出中的消息 */}
      {isLoading && streamingContent && !isSearching && !isDrawing && generatedImages.length === 0 && (
        <div className="flex gap-4 animate-fade-in">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <div className="relative w-6 h-6">
              <Image
                src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
                alt="LockAI"
                width={24}
                height={24}
                className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
              />
              <Image
                src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
                alt="LockAI"
                width={24}
                height={24}
                className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'light' ? 'opacity-100' : 'opacity-0'}`}
              />
            </div>
          </div>
          <div className="max-w-[75%] bg-card border border-border rounded-2xl px-4 py-3">
            <StreamingMarkdown content={streamingContent} />
          </div>
        </div>
      )}

      {/* 搜索中状态 - 显示已有内容 + 搜索提示 */}
      {isSearching && (
        <>
          {streamingContent && (
            <div className="flex gap-4 animate-fade-in">
              <div className="shrink-0 w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                <div className="relative w-6 h-6">
                  <Image
                    src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
                    alt="LockAI"
                    width={24}
                    height={24}
                    className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <Image
                    src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
                    alt="LockAI"
                    width={24}
                    height={24}
                    className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'light' ? 'opacity-100' : 'opacity-0'}`}
                  />
                </div>
              </div>
              <div className="max-w-[75%] bg-card border border-border rounded-2xl px-4 py-3">
                <StreamingMarkdown content={streamingContent} showCursor={false} />
              </div>
            </div>
          )}
          <div className="flex gap-4 animate-fade-in ml-14">
            <div className="bg-primary/10 border border-primary/20 rounded-xl px-4 py-3 min-w-48">
              <div className="flex items-center gap-2 text-primary">
                <Search className="w-4 h-4" />
                <span className="text-sm font-medium">正在搜索</span>
                <Loader2 className="w-3 h-3 animate-spin" />
              </div>
              {searchQuery && (
                <p className="text-xs text-muted-foreground mt-1">
                  {searchQuery}
                </p>
              )}
              {searchKeywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {searchKeywords.map((keyword, index) => (
                    <span 
                      key={`${keyword}-${index}`}
                      className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary animate-fade-in"
                      style={{ animationDelay: `${index * 50}ms` }}
                    >
                      {keyword}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 绘图中状态 */}
      {isDrawing && (
        <>
          {streamingContent && (
            <div className="flex gap-4 animate-fade-in">
              <div className="shrink-0 w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                <div className="relative w-6 h-6">
                  <Image
                    src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
                    alt="LockAI"
                    width={24}
                    height={24}
                    className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <Image
                    src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
                    alt="LockAI"
                    width={24}
                    height={24}
                    className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'light' ? 'opacity-100' : 'opacity-0'}`}
                  />
                </div>
              </div>
              <div className="max-w-[75%] bg-card border border-border rounded-2xl px-4 py-3">
                <StreamingMarkdown content={streamingContent} showCursor={false} />
              </div>
            </div>
          )}
          <div className="flex gap-4 animate-fade-in ml-14">
            <div className="bg-accent/10 border border-accent/20 rounded-xl px-4 py-3 min-w-48">
              <div className="flex items-center gap-2 text-accent">
                <Palette className="w-4 h-4" />
                <span className="text-sm font-medium">正在绘图</span>
                <Loader2 className="w-3 h-3 animate-spin" />
              </div>
              {drawingPrompt && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {drawingPrompt}
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {/* 已生成的图片（流式显示） */}
      {generatedImages.length > 0 && isLoading && (
        <div className="flex gap-4 animate-fade-in">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
            <div className="relative w-6 h-6">
              <Image
                src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
                alt="LockAI"
                width={24}
                height={24}
                className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
              />
              <Image
                src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
                alt="LockAI"
                width={24}
                height={24}
                className={`absolute inset-0 transition-opacity duration-300 ${resolvedTheme === 'light' ? 'opacity-100' : 'opacity-0'}`}
              />
            </div>
          </div>
          <div className="max-w-[75%] bg-card border border-border rounded-2xl px-4 py-3">
            {streamingContent && (
              <div className="mb-3">
                <StreamingMarkdown content={streamingContent} showCursor={false} />
              </div>
            )}
            <div className="grid gap-2">
              {generatedImages.map((img, index) => (
                <img 
                  key={index}
                  src={img} 
                  alt={`生成的图片 ${index + 1}`}
                  className="rounded-lg max-w-full h-auto"
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 等待响应（无内容时） */}
      {isLoading && !streamingContent && !isSearching && (
        <div className="flex gap-4 animate-fade-in">
          <div className="shrink-0 w-10 h-10 rounded-xl bg-muted text-muted-foreground flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
          <div className="bg-card border border-border rounded-2xl px-4 py-3 min-w-48">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-sm">{roleName}正在思考</span>
              {isDeepThinking && (
                <span className="text-xs text-muted-foreground/70 tabular-nums">{thinkingSeconds}s</span>
              )}
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
            {/* Campbell/小锁老师 提示 */}
            {(currentRole === 'campbell' || currentRole === 'xiaosuolaoshi') && thinkingSeconds >= 10 && thinkingSeconds < 30 && (
              <p className="text-xs text-muted-foreground/70 mt-2 animate-fade-in">
                {currentRole === 'campbell' ? 'Campbell' : '小锁老师'}正在深度思考，可能需要一些时间
              </p>
            )}
            {(currentRole === 'campbell' || currentRole === 'xiaosuolaoshi') && thinkingSeconds >= 30 && (
              <p className="text-xs text-muted-foreground/70 mt-2 animate-fade-in">
                受限于舞队算力资源和网络波动，响应可能较慢。如需更快体验，可尝试 Scooby 或 Leo 模型
              </p>
            )}
            {/* Scooby 深度思考提示 */}
            {currentRole === 'scooby' && isDeepThinking && thinkingSeconds >= 8 && thinkingSeconds < 20 && (
              <p className="text-xs text-muted-foreground/70 mt-2 animate-fade-in">
                Scooby 正在深度思考中
              </p>
            )}
            {currentRole === 'scooby' && isDeepThinking && thinkingSeconds >= 20 && (
              <p className="text-xs text-muted-foreground/70 mt-2 animate-fade-in">
                深度思考需要更多时间，可在设置中切换为快速思考模式
              </p>
            )}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
