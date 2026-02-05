'use client';

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import { fixIncompleteMarkdown } from '@/lib/markdown';
import 'katex/dist/katex.min.css';

interface StreamingMarkdownProps {
  content: string;
  showCursor?: boolean;
}

export function StreamingMarkdown({ content, showCursor = true }: StreamingMarkdownProps) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
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
            <blockquote className="border-l-4 border-primary/50 pl-3 my-2 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="px-1.5 py-0.5 rounded text-sm font-mono bg-muted">
                  {children}
                </code>
              );
            }
            const match = /language-(\w+)/.exec(className || '');
            const language = match?.[1] || '';
            return (
              <div className="relative my-2">
                {language && (
                  <div className="text-xs px-2 py-1 rounded-t-lg bg-muted/80 text-muted-foreground">
                    {language}
                  </div>
                )}
                <pre className={`p-3 ${language ? 'rounded-b-lg' : 'rounded-lg'} overflow-x-auto text-sm bg-muted`}>
                  <code className="font-mono">{children}</code>
                </pre>
              </div>
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
              className="text-primary underline hover:no-underline"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-4 border-t border-border" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 rounded-lg border border-border">
              <table className="min-w-full text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b last:border-b-0 border-border">{children}</tr>,
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
        {fixIncompleteMarkdown(content)}
      </ReactMarkdown>
      {showCursor && (
        <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
      )}
    </div>
  );
}
