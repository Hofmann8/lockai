'use client';

import { ChatMessage } from '@/types';
import ReactMarkdown from 'react-markdown';
import { User } from 'lucide-react';
import Image from 'next/image';
import { useTheme } from '@/lib/theme';

interface MessageProps {
  message: ChatMessage;
}

export function Message({ message }: MessageProps) {
  const isUser = message.role === 'user';
  const { resolvedTheme } = useTheme();

  return (
    <div className={`flex gap-4 animate-slide-up ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      {/* Avatar */}
      <div
        className={`
          shrink-0 w-10 h-10 rounded-xl flex items-center justify-center
          transition-transform duration-200 hover:scale-105
          ${isUser 
            ? 'bg-primary text-primary-foreground' 
            : 'bg-muted'
          }
        `}
      >
        {isUser ? (
          <User className="w-5 h-5" />
        ) : (
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
        )}
      </div>

      {/* Message Content */}
      <div
        className={`
          max-w-[75%] rounded-2xl px-4 py-3
          transition-shadow duration-200 hover:shadow-md
          ${isUser 
            ? 'bg-primary text-primary-foreground' 
            : 'bg-card border border-border'
          }
        `}
      >
        <div className={`prose prose-sm max-w-none ${isUser ? 'prose-invert' : 'dark:prose-invert'}`}>
          <ReactMarkdown
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              code: ({ children, className }) => {
                const isInline = !className;
                if (isInline) {
                  return (
                    <code className={`px-1.5 py-0.5 rounded text-sm ${isUser ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                      {children}
                    </code>
                  );
                }
                return (
                  <pre className={`p-3 rounded-lg overflow-x-auto text-sm ${isUser ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                    <code>{children}</code>
                  </pre>
                );
              },
              ul: ({ children }) => <ul className="list-disc pl-4 mb-2">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-4 mb-2">{children}</ol>,
              li: ({ children }) => <li className="mb-1">{children}</li>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:no-underline">
                  {children}
                </a>
              ),
              img: ({ src, alt }) => (
                src ? (
                  <img 
                    src={src} 
                    alt={alt || '图片'} 
                    className="rounded-lg max-w-full h-auto my-2"
                  />
                ) : null
              ),
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
