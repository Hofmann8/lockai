'use client';

import { Sun, Moon, Monitor, LucideIcon } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { useState, useRef, useEffect } from 'react';

interface ThemeToggleProps {
  direction?: 'up' | 'down';
}

export function ThemeToggle({ direction = 'down' }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const options: { value: 'light' | 'dark' | 'system'; label: string; icon: LucideIcon }[] = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '系统', icon: Monitor },
  ];

  const CurrentIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center w-10 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
        aria-label="切换主题"
      >
        <CurrentIcon className="h-5 w-5" />
      </button>

      {isOpen && (
        <div 
          className={`
            absolute w-36 rounded-xl border border-border bg-card shadow-lg overflow-hidden animate-fade-in-scale
            ${direction === 'up' ? 'bottom-12 left-0' : 'top-12 right-0'}
          `}
        >
          {options.map((option) => {
            const Icon = option.icon;
            const isActive = theme === option.value;
            return (
              <button
                key={option.value}
                onClick={() => {
                  setTheme(option.value);
                  setIsOpen(false);
                }}
                className={`
                  w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium
                  transition-colors duration-150 cursor-pointer
                  ${isActive 
                    ? 'bg-primary/10 text-primary' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }
                `}
              >
                <Icon className="h-4 w-4" />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
