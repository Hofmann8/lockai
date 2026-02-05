'use client';

import { useState, useEffect } from 'react';
import { X, Check, Lock } from 'lucide-react';
import { Settings, AIRole, AI_ROLES, getSettings, saveSettings } from '@/lib/settings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<Settings>({ aiRole: 'xiaosuolaoshi' });

  useEffect(() => {
    if (isOpen) {
      setSettings(getSettings());
    }
  }, [isOpen]);

  const handleRoleChange = (role: AIRole, available: boolean) => {
    if (!available) return;
    const newSettings = { ...settings, aiRole: role };
    setSettings(newSettings);
    saveSettings(newSettings);
  };

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
          {/* AI Role Selection */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground">
              AI 助手
            </label>
            <p className="text-xs text-muted-foreground">
              选择你想使用的 AI 助手
            </p>
            <div className="space-y-2">
              {AI_ROLES.map((role) => (
                <button
                  key={role.id}
                  onClick={() => handleRoleChange(role.id, role.available)}
                  disabled={!role.available}
                  className={`
                    w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all
                    ${!role.available
                      ? 'border-border bg-muted/50 cursor-not-allowed opacity-60'
                      : settings.aiRole === role.id
                        ? 'border-primary bg-primary/10 cursor-pointer'
                        : 'border-border hover:border-primary/50 hover:bg-muted cursor-pointer'
                    }
                  `}
                >
                  <div className="text-left">
                    <div className="font-medium text-foreground flex items-center gap-2">
                      {role.name}
                      {!role.available && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {role.available ? role.description : '即将推出'}
                    </div>
                  </div>
                  {role.available && settings.aiRole === role.id && (
                    <Check className="w-5 h-5 text-primary" />
                  )}
                </button>
              ))}
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

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border">
          <p className="text-xs text-muted-foreground text-center">
            设置会自动保存，切换后新对话生效
          </p>
        </div>
      </div>
    </div>
  );
}
