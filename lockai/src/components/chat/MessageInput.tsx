'use client';

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { Send, Loader2, ChevronDown, Brain, Zap } from 'lucide-react';
import { AIRole, AI_ROLES, getSettings, saveSettings } from '@/lib/settings';

interface MessageInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
}

// 模型显示顺序
const MODEL_ORDER: AIRole[] = ['campbell', 'scooby', 'leo', 'xiaosuolaoshi'];

export function MessageInput({ onSend, disabled = false, onActiveChange }: MessageInputProps) {
  const [value, setValue] = useState('');
  const [isHovered, setIsHovered] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [currentRole, setCurrentRole] = useState<AIRole>('scooby');
  const [scoobyDeepThinking, setScoobyDeepThinking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const isActive = isHovered || value.length > 0;

  // 初始化设置
  useEffect(() => {
    const settings = getSettings();
    setCurrentRole(settings.aiRole);
    setScoobyDeepThinking(settings.scoobyDeepThinking);
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (!value.trim() || disabled) return;
    onSend(value);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const handleRoleChange = (role: AIRole) => {
    setCurrentRole(role);
    saveSettings({ aiRole: role });
    setShowModelMenu(false);
  };

  const handleThinkingToggle = () => {
    const newValue = !scoobyDeepThinking;
    setScoobyDeepThinking(newValue);
    saveSettings({ scoobyDeepThinking: newValue });
  };

  const currentRoleConfig = AI_ROLES.find(r => r.id === currentRole);
  const orderedRoles = MODEL_ORDER.map(id => AI_ROLES.find(r => r.id === id)!).filter(Boolean);

  return (
    <div 
      className="relative rounded-2xl bg-card border border-border"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 文本输入区 */}
      <div className="px-4 pt-4 pb-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={disabled}
          rows={1}
          className="
            w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground
            focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
            text-base leading-relaxed
          "
        />
      </div>

      {/* 功能区 */}
      <div className="px-3 pb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {/* 模型选择 */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowModelMenu(!showModelMenu)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            >
              <span>{currentRoleConfig?.name || 'Scooby'}</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${showModelMenu ? 'rotate-180' : ''}`} />
            </button>

            {/* 模型下拉菜单 */}
            {showModelMenu && (
              <div className="absolute bottom-full left-0 mb-2 w-48 py-1 rounded-xl bg-card border border-border shadow-lg z-50 animate-fade-in">
                {orderedRoles.map((role) => (
                  <button
                    key={role.id}
                    onClick={() => handleRoleChange(role.id)}
                    className={`
                      w-full px-3 py-2 text-left text-sm transition-colors cursor-pointer
                      ${currentRole === role.id 
                        ? 'bg-primary/10 text-primary' 
                        : 'text-foreground hover:bg-muted'
                      }
                    `}
                  >
                    <div className="font-medium">{role.name}</div>
                    <div className="text-xs text-muted-foreground">{role.description}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 思考模式切换 */}
          {(() => {
            const canToggle = currentRole === 'scooby';
            const isDeepThinking = currentRole === 'campbell' || currentRole === 'xiaosuolaoshi' || (currentRole === 'scooby' && scoobyDeepThinking);
            
            return (
              <button
                onClick={canToggle ? handleThinkingToggle : undefined}
                disabled={!canToggle}
                title={!canToggle ? '该模型不支持切换思考模式' : undefined}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors
                  ${!canToggle 
                    ? 'opacity-50 cursor-not-allowed' 
                    : 'cursor-pointer'
                  }
                  ${isDeepThinking 
                    ? canToggle ? 'bg-primary/10 text-primary' : 'text-primary/60'
                    : canToggle ? 'text-muted-foreground hover:text-foreground hover:bg-muted' : 'text-muted-foreground/60'
                  }
                `}
              >
                {isDeepThinking ? (
                  <>
                    <Brain className="w-4 h-4" />
                    <span>深度思考</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4" />
                    <span>快速思考</span>
                  </>
                )}
              </button>
            );
          })()}
        </div>

        {/* 发送按钮 */}
        <button
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="
            shrink-0 w-9 h-9 rounded-xl bg-primary text-primary-foreground
            flex items-center justify-center
            hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors duration-200 cursor-pointer
          "
          aria-label="发送消息"
        >
          {disabled ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}
