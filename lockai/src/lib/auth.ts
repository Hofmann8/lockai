import { AuthState } from '@/types';

const AUTH_STORAGE_KEY = 'lockai_auth';
const TOKEN_STORAGE_KEY = 'lockai_token';
const AVATAR_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_LEEWAY_MS = 30 * 1000;
const AUTH_CHANGE_EVENT = 'lockai_auth_change';

// SSO 配置
const SSO_BASE_URL = 'https://auth.funk-and.love';
const SSO_LOGIN_URL = SSO_BASE_URL;

const defaultAuthState: AuthState = {
  isAuthenticated: false,
  user: undefined,
};

function emitAuthStateChange(state: AuthState): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AuthState>(AUTH_CHANGE_EVENT, { detail: state }));
}

/**
 * 获取当前回调地址
 */
function getCallbackUrl(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/callback`;
}

function parseAmzDateToEpochMs(value: string): number | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

function parseJwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;

    const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payloadPadded = payloadBase64.padEnd(Math.ceil(payloadBase64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(payloadPadded)) as { exp?: number };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function isTokenExpired(token: string, leewayMs: number = TOKEN_EXPIRY_LEEWAY_MS): boolean {
  const expiresAt = parseJwtExpiryMs(token);
  if (!expiresAt) return false;
  return Date.now() + Math.max(0, leewayMs) >= expiresAt;
}

/**
 * 从 AWS S3 预签名 URL 里解析过期时间（毫秒时间戳）
 */
export function getSignedUrlExpiry(url: string): number | null {
  try {
    const parsed = new URL(url);
    const signedAtRaw = parsed.searchParams.get('X-Amz-Date');
    const expiresRaw = parsed.searchParams.get('X-Amz-Expires');
    if (!signedAtRaw || !expiresRaw) return null;

    const signedAt = parseAmzDateToEpochMs(signedAtRaw);
    const expiresSec = Number(expiresRaw);
    if (!signedAt || !Number.isFinite(expiresSec)) return null;

    return signedAt + expiresSec * 1000;
  } catch {
    return null;
  }
}

/**
 * 判断预签名 URL 是否已过期（或临近过期）
 */
export function isSignedUrlExpired(url: string, leewayMs: number = AVATAR_REFRESH_LEEWAY_MS): boolean {
  const expiresAt = getSignedUrlExpiry(url);
  if (!expiresAt) return false;
  return Date.now() + Math.max(0, leewayMs) >= expiresAt;
}

/**
 * Get current authentication state from localStorage
 */
export function getAuthState(): AuthState {
  if (typeof window === 'undefined') {
    return defaultAuthState;
  }
  
  const stored = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!stored) {
    return defaultAuthState;
  }

  try {
    const state = JSON.parse(stored) as AuthState;
    const user = state.user;
    const avatarUrl = user?.avatarUrl;
    // 本地缓存的签名 URL 过期后，自动清理，避免直接触发 403。
    if (user && avatarUrl && isSignedUrlExpired(avatarUrl, 0)) {
      user.avatarUrl = undefined;
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
    }
    return state;
  } catch {
    return defaultAuthState;
  }
}

/**
 * Get stored token
 */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!token) return null;
  if (isTokenExpired(token)) {
    logout();
    return null;
  }
  return token;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return getAuthState().isAuthenticated && !!getToken();
}

/**
 * 跳转到 SSO 登录页
 */
export function redirectToSSO(): void {
  const callbackUrl = getCallbackUrl();
  const loginUrl = `${SSO_LOGIN_URL}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  window.location.href = loginUrl;
}

/**
 * 处理 SSO 回调，保存用户信息
 */
export function handleSSOCallback(params: URLSearchParams): AuthState | null {
  const token = params.get('token');
  const userId = params.get('user_id');
  const email = params.get('email');
  const name = params.get('name');
  
  if (!token) {
    return null;
  }

  if (isTokenExpired(token, 0)) {
    return null;
  }
  
  // 保存 token
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
  
  // 保存用户状态
  const authState: AuthState = {
    isAuthenticated: true,
    user: {
      id: userId || undefined,
      name: name || 'Funk&Love Member',
      email: email || '',
    },
  };
  
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authState));
  emitAuthStateChange(authState);
  return authState;
}

/**
 * 验证 token 有效性
 */
export async function verifyToken(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  
  try {
    const response = await fetch(`${SSO_BASE_URL}/api/auth/verify-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Logout function - clears authentication state
 */
export function logout(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  emitAuthStateChange(defaultAuthState);
}

/**
 * Subscribe to auth state changes (for components that need reactivity)
 */
export function onAuthStateChange(callback: (state: AuthState) => void): () => void {
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === AUTH_STORAGE_KEY) {
      callback(e.newValue ? JSON.parse(e.newValue) : defaultAuthState);
    }
  };
  const handleAuthChange = (e: Event) => {
    const event = e as CustomEvent<AuthState>;
    callback(event.detail);
  };
  
  window.addEventListener('storage', handleStorageChange);
  window.addEventListener(AUTH_CHANGE_EVENT, handleAuthChange);
  return () => {
    window.removeEventListener('storage', handleStorageChange);
    window.removeEventListener(AUTH_CHANGE_EVENT, handleAuthChange);
  };
}

/**
 * 获取当前用户头像
 */
export async function fetchUserAvatar(style: 'avatarsm' | 'avatarmd' | 'avatarlg' = 'avatarmd'): Promise<string | null> {
  const token = getToken();
  if (!token) return null;
  
  try {
    const response = await fetch(`${SSO_BASE_URL}/api/auth/me/avatar?style=${style}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });
    
    if (response.status === 401) {
      logout();
      return null;
    }
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data.success && data.has_avatar && data.avatar_url) {
      return data.avatar_url;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 更新本地存储的头像 URL
 */
export function updateAvatarUrl(avatarUrl: string | null): void {
  const authState = getAuthState();
  if (authState.user) {
    authState.user.avatarUrl = avatarUrl || undefined;
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authState));
    emitAuthStateChange(authState);
  }
}
