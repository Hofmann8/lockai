/** 拼接 className，忽略假值 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 快捷键展示：Mac 显示 ⌘，其他显示 Ctrl */
export const modKey = () => (isMac() ? '⌘' : 'Ctrl');
