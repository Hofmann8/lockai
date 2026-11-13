'use client';

import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { useTheme, type Theme } from '@/lib/theme';
import { getSettings, onSettingsChange, saveSettings, type ChatSettings } from '@/lib/settings';
import { getAuthState } from '@/lib/auth';
import { getUsage, recordWatermarkChoice, type CampbellUsage } from '@/lib/api';
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

/** 关闭水印前讲明标识义务；确认后先在服务端留存记录，记成功才关 */
function WatermarkOffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (open) setFailed(false);
  }, [open]);

  const confirm = async () => {
    const userId = getAuthState().user?.id;
    setBusy(true);
    const ok = Boolean(userId) && (await recordWatermarkChoice(userId!, false));
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    saveSettings({ watermark: false });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="关闭图片水印？" className="max-w-[420px]">
      <div className="space-y-3 px-6 pb-6 text-[13px] leading-relaxed text-fg-soft">
        <p>
          根据《人工智能生成合成内容标识办法》，AI 生成的图片应当添加显式标识。关闭后，图片上不再显示 LockAI 水印；文件中的隐式标识仍然保留。
        </p>
        <div>
          <p>确认关闭，即表示你同意：</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5">
            <li>发布或传播这些图片时，主动声明其为 AI 生成内容；</li>
            <li>不删除、篡改或隐匿图片中的隐式标识；</li>
            <li>承担因未履行标识义务产生的法律责任。</li>
          </ul>
        </div>
        <p className="text-xs text-fg-faint">本次操作将依法留存记录，保存不少于六个月。</p>
        {failed && <p className="text-xs text-danger">没能保存，请稍后再试。</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            className="h-9 rounded-xl px-4 text-[13px] text-fg transition-colors hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
            className="flex h-9 items-center gap-2 whitespace-nowrap rounded-xl bg-ink px-4 text-[13px] text-ink-fg transition-opacity disabled:opacity-50"
          >
            关闭水印
          </button>
        </div>
      </div>
    </Dialog>
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

/** 重置时间按本地时间显示：11月20日 14:05 */
function resetLabel(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  const [confirmWatermarkOff, setConfirmWatermarkOff] = useState(false);

  const toggleWatermark = (on: boolean) => {
    if (!on) {
      setConfirmWatermarkOff(true);
      return;
    }
    saveSettings({ watermark: true });
    const userId = getAuthState().user?.id;
    if (userId) void recordWatermarkChoice(userId, true);
  };

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
          <Row title="图片水印" description="生成的图片显示 LockAI 标记">
            <Toggle label="图片水印" checked={settings.watermark} onChange={toggleWatermark} />
          </Row>
        </section>
        <WatermarkOffDialog open={confirmWatermarkOff} onClose={() => setConfirmWatermarkOff(false)} />

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
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-[13.5px] font-medium text-fg">Campbell 用量</span>
            {usage && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent-ink">{usage.tier.name}</span>}
          </div>
          <Meter label="本周" used={usage?.week.credits ?? null} limit={usage?.limits.weekly ?? 200} />
          {usage && (
            <p className="mt-2 text-[11.5px] tabular-nums text-fg-faint">
              {usage.resets_at ? `${resetLabel(usage.resets_at)} 重置` : '首次使用起 7 天为一个周期'}
            </p>
          )}
        </section>

        <section className="mt-5 flex items-center justify-between text-[11.5px] text-fg-faint">
          <span>LockAI 1.0 · Funk&amp;Love</span>
          <a href="mailto:link-ai@zju.edu.cn" className="transition-colors hover:text-fg">link-ai@zju.edu.cn</a>
        </section>
      </div>
    </Dialog>
  );
}
