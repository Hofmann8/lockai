'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { useTheme, type Theme } from '@/lib/theme';
import { getSettings, onSettingsChange, saveSettings, type ChatSettings } from '@/lib/settings';
import { getAuthState } from '@/lib/auth';
import { getUsage, type CampbellUsage } from '@/lib/api';
import { cn } from '@/lib/cn';

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T, event: MouseEvent) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-xl bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={(e) => onChange(o.value, e)}
          className={cn(
            'h-7 rounded-[10px] px-3 text-[12.5px] transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-soft' : 'text-fg-faint hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200', checked ? 'bg-ink' : 'bg-line-strong')}
    >
      <span
        className={cn(
          'absolute left-0 top-0.5 h-5 w-5 rounded-full bg-surface shadow-soft transition-transform duration-300 ease-[var(--ease-lock)]',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-[13.5px] text-fg">{title}</div>
        {description && <div className="mt-0.5 text-xs leading-relaxed text-fg-faint">{description}</div>}
      </div>
      {children}
    </div>
  );
}

/** 两三个互斥选项、每个都需要一句解释时用：比分段按钮多一行说明 */
function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; description: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" className="grid grid-cols-2 gap-2">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative rounded-2xl border px-3.5 py-3 text-left transition-[border-color,background-color,box-shadow] duration-150',
              active ? 'border-line-strong bg-surface shadow-soft' : 'border-line hover:border-line-strong hover:bg-surface/60',
            )}
          >
            <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <span
                className={cn(
                  'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors',
                  active ? 'border-ink bg-ink' : 'border-line-strong',
                )}
              >
                {active && <span className="h-1.5 w-1.5 rounded-full bg-ink-fg animate-pop" />}
              </span>
              {o.label}
            </span>
            <span className="mt-1.5 block text-[11.5px] leading-relaxed text-fg-faint">{o.description}</span>
          </button>
        );
      })}
    </div>
  );
}

function Meter({ label, used, limit }: { label: string; used: number | null; limit: number }) {
  const loading = used === null;
  const pct = !loading && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const exhausted = !loading && used >= limit;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="text-fg-soft">{label}</span>
        {loading ? (
          <span className="h-3 w-20 animate-pulse rounded-full bg-surface-2" />
        ) : (
          <span className={cn('tabular-nums', exhausted ? 'text-danger' : 'text-fg')}>
            {used.toFixed(1)} <span className="text-fg-faint">/ {limit}</span>
          </span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', exhausted ? 'bg-danger' : 'bg-accent')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<ChatSettings>(() => getSettings());
  const [usage, setUsage] = useState<CampbellUsage | null>(null);

  useEffect(() => {
    setSettings(getSettings());
    return onSettingsChange(setSettings);
  }, []);

  useEffect(() => {
    if (!open) return;
    const userId = getAuthState().user?.id;
    if (!userId) return;
    let cancelled = false;
    void getUsage(userId).then((data) => {
      if (!cancelled) setUsage(data);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="设置" className="max-w-[480px]">
      <div className="max-h-[72vh] overflow-y-auto px-6 pb-6">
        <section className="divide-y divide-line">
          <Row title="外观">
            <Segmented<Theme>
              value={theme}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'system', label: '跟随系统' },
              ]}
              onChange={(value, e) => setTheme(value, { x: e.clientX, y: e.clientY })}
            />
          </Row>
          <Row title="追问建议" description="回答结束后给出几个可以接着问的方向">
            <Toggle label="追问建议" checked={settings.suggestions} onChange={(v) => saveSettings({ suggestions: v })} />
          </Row>
          <Row title="画图质量" description={settings.imageQuality === 'hd' ? '高清，出图更慢、消耗更多' : '标准，出图更快'}>
            <Segmented
              value={settings.imageQuality}
              options={[
                { value: 'standard', label: '标准' },
                { value: 'hd', label: '高清' },
              ]}
              onChange={(value) => saveSettings({ imageQuality: value })}
            />
          </Row>
        </section>

        <section className="border-t border-line pb-4 pt-3">
          <div className="text-[13.5px] text-fg">文档和幻灯片</div>
          <div className="mb-2.5 mt-0.5 text-xs leading-relaxed text-fg-faint">写文档、做演示时更看重哪一点；对话里另有要求时以对话为准</div>
          <ChoiceCards
            value={settings.delivery}
            options={[
              { value: 'quality', label: '排版质量优先', description: '版面精致考究，拿来就能提交、展示' },
              { value: 'editable', label: '方便编辑优先', description: '拿到就能动手改，适合还要打磨的稿子' },
            ]}
            onChange={(value) => saveSettings({ delivery: value })}
          />
        </section>

        <section className="mt-1 rounded-2xl border border-line p-4">
          <div className="mb-3 text-[13.5px] font-medium text-fg">Campbell 用量</div>
          <div className="space-y-3.5">
            <Meter label="今天" used={usage?.today.credits ?? null} limit={usage?.limits.daily ?? 100} />
            <Meter label="本月" used={usage?.month.credits ?? null} limit={usage?.limits.monthly ?? 1000} />
          </div>
          <p className="mt-3 text-[11.5px] leading-relaxed text-fg-faint">
            Campbell 按实际用量计费，问题越长、对话越久消耗越多，一问一答大约 1 credit。Scooby 聊天免费，但画图仍然计入 Campbell 配额。
          </p>
        </section>

        <section className="mt-5 flex items-center justify-between text-[11.5px] text-fg-faint">
          <span>LockAI 1.0 · Funk&amp;Love</span>
          <a href="mailto:link-ai@zju.edu.cn" className="transition-colors hover:text-fg">link-ai@zju.edu.cn</a>
        </section>
      </div>
    </Dialog>
  );
}
