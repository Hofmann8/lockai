'use client';

import { X } from 'lucide-react';
import { useTheme } from '@/lib/theme';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 rounded-2xl border border-border bg-card shadow-2xl animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">设置</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* 显示设置 */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground">
              显示设置
            </label>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">主题</span>
                <div className="flex gap-1 p-1 rounded-lg bg-muted">
                  <button
                    onClick={() => setTheme('light')}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                      theme === 'light' 
                        ? 'bg-card text-foreground shadow-sm' 
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    浅色
                  </button>
                  <button
                    onClick={() => setTheme('dark')}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                      theme === 'dark' 
                        ? 'bg-card text-foreground shadow-sm' 
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    深色
                  </button>
                  <button
                    onClick={() => setTheme('system')}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                      theme === 'system' 
                        ? 'bg-card text-foreground shadow-sm' 
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    跟随系统
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* About */}
          <div className="space-y-3 pt-2 border-t border-border">
            <label className="text-sm font-medium text-foreground">
              关于 LockAI
            </label>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>开发者：Hofmann</p>
              <p>
                联系邮箱：
                <a 
                  href="mailto:link-ai@zju.edu.cn" 
                  className="text-primary hover:underline"
                >
                  link-ai@zju.edu.cn
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
