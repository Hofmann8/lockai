'use client';

import { useMemo, useRef } from 'react';
import { ChatMessage } from '@/types';
import { Message } from './Message';
import { Loader2 } from 'lucide-react';
import Lottie from 'lottie-react';
import lockAnimation from '../../../public/Unlock.json';
import { useAutoScroll } from '@/lib/hooks/useAutoScroll';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingMessageId?: string | null;
  streamingContentOverride?: string;
  waitingSeconds?: number;
  searchSeconds?: number;
  imageGenSeconds?: number;
  toolFollowupSeconds?: number;
  thinkingEnabled?: boolean;
  onRecall?: (message: ChatMessage) => void;
}

export function MessageList({
  messages,
  isLoading,
  streamingMessageId,
  streamingContentOverride,
  waitingSeconds = 0,
  searchSeconds = 0,
  imageGenSeconds = 0,
  toolFollowupSeconds = 0,
  thinkingEnabled = true,
  onRecall,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessage = messages[messages.length - 1];
  const scrollBehavior: ScrollBehavior = isLoading ? 'auto' : 'smooth';

  useAutoScroll(
    containerRef,
    [messages.length, lastMessage?.id, streamingContentOverride ?? lastMessage?.content, isLoading],
    scrollBehavior,
  );

  const lastIndex = messages.length - 1;
  const renderedMessages = useMemo(() => messages.map((message, index) => {
    const isActiveAssistant = isLoading && index === lastIndex && message.role === 'assistant';
    return (
      <Message
        key={message.id}
        message={message}
        contentOverride={isActiveAssistant && message.id === streamingMessageId ? streamingContentOverride : undefined}
        onRecall={onRecall}
        isStreaming={isActiveAssistant}
        waitingSeconds={isActiveAssistant ? waitingSeconds : 0}
        searchSeconds={isActiveAssistant ? searchSeconds : 0}
        imageGenSeconds={isActiveAssistant ? imageGenSeconds : 0}
        toolFollowupSeconds={isActiveAssistant ? toolFollowupSeconds : 0}
        thinkingEnabled={isActiveAssistant ? thinkingEnabled : true}
      />
    );
  }), [
    messages,
    isLoading,
    lastIndex,
    streamingMessageId,
    streamingContentOverride,
    onRecall,
    waitingSeconds,
    searchSeconds,
    imageGenSeconds,
    toolFollowupSeconds,
    thinkingEnabled,
  ]);

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="relative h-full min-h-0">
        <div className="h-full flex flex-col items-center justify-center text-muted-foreground animate-fade-in">
          <div className="w-20 h-20 mb-4 opacity-50">
            <Lottie animationData={lockAnimation} loop={false} autoplay />
          </div>
          <p className="text-lg font-medium">开始新的对话</p>
          <p className="text-sm mt-1">支持联网搜索、图片生成和图片编辑</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div
        ref={containerRef}
        className="h-full overflow-y-auto"
        role="log"
        aria-label="对话消息"
      >
        <div className="max-w-4xl mx-auto px-4 pt-6 pb-6 space-y-6">
          {renderedMessages}

          {isLoading && messages.length === 0 && (
            <div className="flex gap-4 animate-fade-in">
              <div className="shrink-0 w-10 h-10 rounded-xl bg-muted text-muted-foreground flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
              <div className="text-sm text-muted-foreground pt-2">正在初始化会话...</div>
            </div>
          )}
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-background to-transparent" />
    </div>
  );
}
