'use client';

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { getSettings, saveSettings, onSettingsChange, type ImageQuality } from '@/lib/settings';
import { getAuthState } from '@/lib/auth';
import { getUsage, type CampbellUsage } from '@/lib/api';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [imageQuality, setImageQuality] = useState<ImageQuality>('standard');
  const [usage, setUsage] = useState<CampbellUsage | null>(null);

  useEffect(() => {
    setImageQuality(getSettings().imageQuality);
    return onSettingsChange((s) => setImageQuality(s.imageQuality));
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const userId = getAuthState().user?.id;
    if (!userId) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    getUsage(userId).then((data) => {
      if (!cancelled) setUsage(data);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const updateImageQuality = (next: ImageQuality) => {
    setImageQuality(next);
    saveSettings({ imageQuality: next });
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

          {/* Campbell 用量 */}
          <div className="space-y-2 pt-2 border-t border-border">
            <label className="text-sm font-medium text-foreground">Campbell 用量</label>
            <div className="space-y-2 text-xs">
              <UsageRow
                label="今日"
                used={usage?.today.credits ?? null}
                limit={usage?.limits.daily ?? 100}
              />
              <UsageRow
                label="本月"
                used={usage?.month.credits ?? null}
                limit={usage?.limits.monthly ?? 1000}
              />
              <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                Campbell 模型开销较大，为防止滥用设有日 / 月限额。
                Scooby 和 Leo 对话本身免费，但出图依然消耗 Campbell 配额。
              </p>
            </div>
          </div>

          {/* 图像生成 */}
          <div className="space-y-3 pt-2 border-t border-border">
            <label className="text-sm font-medium text-foreground">
              图像生成
            </label>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-sm text-muted-foreground">绘图模型</span>
                  <span className="text-xs text-muted-foreground/70">
                    {imageQuality === 'hd' ? '高清，每张约需数分钟' : '实时，快速响应'}
                  </span>
                </div>
                <div className="flex gap-1 p-1 rounded-lg bg-muted">
                  <button
                    onClick={() => updateImageQuality('standard')}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                      imageQuality === 'standard'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Campbell 1.5
                  </button>
                  <button
                    onClick={() => updateImageQuality('hd')}
                    className={`px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer ${
                      imageQuality === 'hd'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Campbell 2.0
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
              <p>版本：0.8</p>
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

interface UsageRowProps {
  label: string;
  used: number | null;
  limit: number;
}

function UsageRow({ label, used, limit }: UsageRowProps) {
  const loading = used === null;
  const pct = !loading && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const exhausted = !loading && used >= limit;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">{label}</span>
        {loading ? (
          <span className="h-3 w-16 rounded bg-muted animate-pulse" />
        ) : (
          <span className={exhausted ? 'text-destructive' : 'text-foreground'}>
            {used} / {limit} credits
          </span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        {loading ? (
          <div className="h-full w-1/3 bg-muted-foreground/20 animate-pulse" />
        ) : (
          <div
            className={`h-full transition-all ${exhausted ? 'bg-destructive' : 'bg-primary'}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
