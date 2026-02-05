'use client';

import { useState } from 'react';
import { ChatMessage } from '@/types';
import ReactMarkdown from 'react-markdown';
import { User, Copy, Check } from 'lucide-react';
import Image from 'next/image';
import { useTheme } from '@/lib/theme';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface MessageProps {
  message: ChatMessage;
}

function CodeBlock({ language, children, isUser }: { language: string; children: string; isUser: boolean }) {
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative my-2 group">
      <div className={`flex items-center justify-between text-xs px-3 py-1.5 rounded-t-lg ${isUser ? 'bg-primary-foreground/10' : 'bg-muted'}`}>
        <span className="text-muted-foreground">{language || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={resolvedTheme === 'dark' ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
          borderBottomLeftRadius: '0.5rem',
          borderBottomRightRadius: '0.5rem',
          fontSize: '0.875rem',
        }}
        showLineNumbers={children.split('\n').length > 3}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
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
          ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'}
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
          ${isUser ? 'bg-primary text-primary-foreground' : 'bg-card border border-border'}
        `}
      >
        <div className={`prose prose-sm max-w-none ${isUser ? 'prose-invert' : 'dark:prose-invert'}`}>
          <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm]}
            rehypePlugins={[rehypeKatex]}
            components={{
              h1: ({ children }) => <h1 className="text-2xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
              h2: ({ children }) => <h2 className="text-xl font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
              h3: ({ children }) => <h3 className="text-lg font-semibold mb-2 mt-3 first:mt-0">{children}</h3>,
              h4: ({ children }) => <h4 className="text-base font-semibold mb-2 mt-2 first:mt-0">{children}</h4>,
              h5: ({ children }) => <h5 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h5>,
              h6: ({ children }) => <h6 className="text-sm font-medium mb-1 mt-2 first:mt-0">{children}</h6>,
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }) => <em className="italic">{children}</em>,
              del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
              blockquote: ({ children }) => (
                <blockquote className={`border-l-4 pl-3 my-2 italic ${isUser ? 'border-primary-foreground/50' : 'border-primary/50 text-muted-foreground'}`}>
                  {children}
                </blockquote>
              ),
              code: ({ children, className }) => {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !className;
                
                if (isInline) {
                  return (
                    <code className={`px-1.5 py-0.5 rounded text-sm font-mono ${isUser ? 'bg-primary-foreground/20' : 'bg-muted'}`}>
                      {children}
                    </code>
                  );
                }
                
                return (
                  <CodeBlock language={match?.[1] || ''} isUser={isUser}>
                    {String(children).replace(/\n$/, '')}
                  </CodeBlock>
                );
              },
              pre: ({ children }) => <>{children}</>,
              ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
              li: ({ children }) => <li className="mb-0.5">{children}</li>,
              a: ({ href, children }) => (
                <a 
                  href={href} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className={`underline hover:no-underline ${isUser ? '' : 'text-primary'}`}
                >
                  {children}
                </a>
              ),
              hr: () => <hr className={`my-4 border-t ${isUser ? 'border-primary-foreground/30' : 'border-border'}`} />,
              table: ({ children }) => (
                <div className="overflow-x-auto my-2 rounded-lg border border-border">
                  <table className="min-w-full text-sm">{children}</table>
                </div>
              ),
              thead: ({ children }) => <thead className={`${isUser ? 'bg-primary-foreground/10' : 'bg-muted'}`}>{children}</thead>,
              tbody: ({ children }) => <tbody>{children}</tbody>,
              tr: ({ children }) => <tr className={`border-b last:border-b-0 ${isUser ? 'border-primary-foreground/20' : 'border-border'}`}>{children}</tr>,
              th: ({ children }) => <th className="px-3 py-2 text-left font-semibold">{children}</th>,
              td: ({ children }) => <td className="px-3 py-2">{children}</td>,
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
