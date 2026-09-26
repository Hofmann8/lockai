import type { ThinkingLevel } from '@/types';

export type ImageQuality = 'standard' | 'hd';
/** 文档 / 幻灯片交付：排版质量优先（LaTeX、网页排版出 PDF，另转 Word）或方便编辑优先（直接出 Word / PPT） */
export type DeliveryMode = 'quality' | 'editable';

export interface ChatSettings {
  selectedModelId: string | null;
  thinkingLevel: ThinkingLevel;
  imageQuality: ImageQuality;
  /** 回答结束后给出追问建议 */
  suggestions: boolean;
  delivery: DeliveryMode;
}

const SETTINGS_KEY = 'lockai_settings';
const SETTINGS_CHANGE_EVENT = 'lockai_settings_change';

const defaultSettings: ChatSettings = {
  selectedModelId: 'scooby',
  thinkingLevel: 'standard',
  imageQuality: 'standard',
  suggestions: true,
  delivery: 'quality',
};

function normalizeSettings(raw: Record<string, unknown>): ChatSettings {
  const merged: ChatSettings = { ...defaultSettings, ...(raw as Partial<ChatSettings>) };
  // 兼容旧版 thinkingEnabled: boolean
  if (!['fast', 'standard', 'deep'].includes(merged.thinkingLevel as string)) {
    const legacy = (raw as { thinkingEnabled?: boolean }).thinkingEnabled;
    merged.thinkingLevel = legacy === false ? 'fast' : 'standard';
  }
  if (!['standard', 'hd'].includes(merged.imageQuality as string)) {
    merged.imageQuality = 'standard';
  }
  merged.suggestions = merged.suggestions !== false;
  if (!['quality', 'editable'].includes(merged.delivery as string)) {
    merged.delivery = 'quality';
  }
  return merged;
}

export function getSettings(): ChatSettings {
  if (typeof window === 'undefined') return defaultSettings;
  const stored = localStorage.getItem(SETTINGS_KEY);
  if (!stored) return defaultSettings;
  try {
    return normalizeSettings(JSON.parse(stored));
  } catch {
    return defaultSettings;
  }
}

export function saveSettings(settings: Partial<ChatSettings>): void {
  if (typeof window === 'undefined') return;
  const current = getSettings();
  const updated = { ...current, ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGE_EVENT, { detail: updated }));
}

export function onSettingsChange(callback: (settings: ChatSettings) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => callback((e as CustomEvent<ChatSettings>).detail);
  window.addEventListener(SETTINGS_CHANGE_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, handler);
}
