import type { ThinkingLevel } from '@/types';

export type ImageQuality = 'standard' | 'hd';

export interface ChatSettings {
  selectedModelId: string | null;
  thinkingLevel: ThinkingLevel;
  imageQuality: ImageQuality;
  /** 回答结束后给出追问建议 */
  suggestions: boolean;
}

const SETTINGS_KEY = 'lockai_settings';
const SETTINGS_CHANGE_EVENT = 'lockai_settings_change';

const defaultSettings: ChatSettings = {
  selectedModelId: 'campbell',
  thinkingLevel: 'standard',
  imageQuality: 'standard',
  suggestions: true,
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
