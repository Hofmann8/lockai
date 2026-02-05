'use client';

import { useRef, useEffect, useState } from 'react';
import { ChatMessage } from '@/types';
import { Message } from './Message';
import { Loader2, Search, Palette } from 'lucide-react';
import { getCurrentRoleName, onSettingsChange } from '@/lib/settings';
import { fixIncompleteMarkdown } from '@/lib/markdown';
import ReactMarkdown from 'react-markdown';
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
  const prevInputActive = useRef(isInputActive);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    setRoleName(getCurrentRoleName());
    return onSettingsChange(() => {
      setRoleName(getCurrentRoleName());
    });
  }, []);

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
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown
                components={{
                  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                  code: ({ children, className }) => {
                    const isInline = !className;
                    if (isInline) {
                      return <code className="px-1.5 py-0.5 rounded text-sm bg-muted">{children}</code>;
                    }
                    return (
                      <pre className="p-3 rounded-lg overflow-x-auto text-sm bg-muted">
                        <code>{children}</code>
                      </pre>
                    );
                  },
                  ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
                  li: ({ children }) => <li className="mb-1">{children}</li>,
                }}
              >
                {fixIncompleteMarkdown(streamingContent)}
              </ReactMarkdown>
              <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
            </div>
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
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      code: ({ children, className }) => {
                        const isInline = !className;
                        if (isInline) {
                          return <code className="px-1.5 py-0.5 rounded text-sm bg-muted">{children}</code>;
                        }
                        return (
                          <pre className="p-3 rounded-lg overflow-x-auto text-sm bg-muted">
                            <code>{children}</code>
                          </pre>
                        );
                      },
                    }}
                  >
                    {fixIncompleteMarkdown(streamingContent)}
                  </ReactMarkdown>
                </div>
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
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      code: ({ children, className }) => {
                        const isInline = !className;
                        if (isInline) {
                          return <code className="px-1.5 py-0.5 rounded text-sm bg-muted">{children}</code>;
                        }
                        return (
                          <pre className="p-3 rounded-lg overflow-x-auto text-sm bg-muted">
                            <code>{children}</code>
                          </pre>
                        );
                      },
                    }}
                  >
                    {fixIncompleteMarkdown(streamingContent)}
                  </ReactMarkdown>
                </div>
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
              <div className="prose prose-sm max-w-none dark:prose-invert mb-3">
                <ReactMarkdown
                  components={{
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                  }}
                >
                  {fixIncompleteMarkdown(streamingContent)}
                </ReactMarkdown>
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
          <div className="bg-card border border-border rounded-2xl px-4 py-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="text-sm">{roleName}正在思考</span>
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
