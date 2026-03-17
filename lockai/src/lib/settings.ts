export interface ChatSettings {
  selectedModelId: string | null;
  thinkingEnabled: boolean;
}

const SETTINGS_KEY = 'lockai_settings';
const SETTINGS_CHANGE_EVENT = 'lockai_settings_change';

const defaultSettings: ChatSettings = {
  selectedModelId: 'campbell',
  thinkingEnabled: true,
};

export function getSettings(): ChatSettings {
  if (typeof window === 'undefined') return defaultSettings;
  const stored = localStorage.getItem(SETTINGS_KEY);
  if (!stored) return defaultSettings;
  try {
    return { ...defaultSettings, ...JSON.parse(stored) };
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
