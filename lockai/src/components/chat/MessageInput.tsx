'use client';

import { useState, useRef, useCallback, useEffect, KeyboardEvent } from 'react';
import { Send, Loader2, ChevronDown, Brain, Zap, ImagePlus, X } from 'lucide-react';
import { AIRole, AI_ROLES, EffectiveAIRole, getEffectiveRoleFromState, getSettings, saveSettings } from '@/lib/settings';
import { compressImage, ACCEPTED_IMAGE_TYPES } from '@/lib/image';

interface MessageInputProps {
  onSend: (message: string, effectiveRole: EffectiveAIRole, images?: string[]) => void;
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
  defaultValue?: string;
  defaultImages?: string[];
}

// 模型显示顺序
const MODEL_ORDER: AIRole[] = ['campbell', 'scooby', 'leo', 'xiaosuolaoshi'];

export function MessageInput({ onSend, disabled = false, onActiveChange, defaultValue, defaultImages }: MessageInputProps) {
  const [value, setValue] = useState(defaultValue || '');
  const [isHovered, setIsHovered] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [currentRole, setCurrentRole] = useState<AIRole>('scooby');
  const [scoobyDeepThinking, setScoobyDeepThinking] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>(defaultImages || []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isActive = isHovered || value.length > 0 || pendingImages.length > 0;

  // 初始化设置
  useEffect(() => {
    const settings = getSettings();
    setCurrentRole(settings.aiRole);
    setScoobyDeepThinking(settings.scoobyDeepThinking);
  }, []);

  // 外部设置输入框内容（撤回时）
  useEffect(() => {
    if (defaultValue !== undefined) {
      setValue(defaultValue);
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
        }
      }, 0);
    }
  }, [defaultValue]);

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
    if ((!value.trim() && pendingImages.length === 0) || disabled) return;
    const effectiveRole = getEffectiveRoleFromState(currentRole, scoobyDeepThinking);
    onSend(value, effectiveRole, pendingImages.length > 0 ? pendingImages : undefined);
    setValue('');
    setPendingImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend, currentRole, scoobyDeepThinking, pendingImages]);

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

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newImages: string[] = [];
    for (const file of Array.from(files)) {
      if (pendingImages.length + newImages.length >= 4) break;
      const dataUrl = await compressImage(file);
      newImages.push(dataUrl);
    }
    setPendingImages(prev => [...prev, ...newImages].slice(0, 4));
    // 重置 input 以便重复选择同一文件
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index));
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/') && pendingImages.length < 4) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          compressImage(file).then(dataUrl => {
            setPendingImages(prev => [...prev, dataUrl].slice(0, 4));
          });
        }
        return;
      }
    }
  }, [pendingImages.length]);

  const currentRoleConfig = AI_ROLES.find(r => r.id === currentRole);
  const orderedRoles = MODEL_ORDER.map(id => AI_ROLES.find(r => r.id === id)!).filter(r => r && r.available);

  return (
    <div 
      className="relative rounded-2xl bg-card border border-border"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* 图片预览 + 文本输入区 */}
      <div className="px-4 pt-4 pb-2">
        {pendingImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group/img w-16 h-16 rounded-lg overflow-hidden border border-border">
                <img src={img} alt={`图片 ${i + 1}`} className="w-full h-full object-cover" />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-foreground/80 text-background flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            adjustHeight();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={pendingImages.length > 0 ? '添加描述... (Enter 发送)' : '输入消息... (Enter 发送, Shift+Enter 换行)'}
          disabled={disabled}
          rows={1}
          className="
            w-full resize-none bg-transparent text-foreground placeholder:text-muted-foreground
            focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed
            text-base leading-relaxed
          "
        />
      </div>

      {/* 隐藏的文件选择 */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES}
        multiple
        className="hidden"
        onChange={handleImageSelect}
      />

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
                {orderedRoles.map((role) => {
                  const isDisabled = role.id === 'xiaosuolaoshi';
                  return (
                    <button
                      key={role.id}
                      onClick={() => !isDisabled && handleRoleChange(role.id)}
                      title={isDisabled ? 'Coming Soon' : undefined}
                      className={`
                        w-full px-3 py-2 text-left text-sm transition-colors
                        ${isDisabled
                          ? 'opacity-40 cursor-not-allowed'
                          : currentRole === role.id 
                            ? 'bg-primary/10 text-primary cursor-pointer' 
                            : 'text-foreground hover:bg-muted cursor-pointer'
                        }
                      `}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{role.name}</span>
                        <span className="text-[10px] text-muted-foreground">v{role.version}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{isDisabled ? 'Coming Soon' : role.description}</div>
                    </button>
                  );
                })}
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
          {/* 图片上传 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || pendingImages.length >= 4}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            title="添加图片 (最多4张)"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
        </div>

        {/* 发送按钮 */}
        <button
          onClick={handleSubmit}
          disabled={disabled || (!value.trim() && pendingImages.length === 0)}
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
