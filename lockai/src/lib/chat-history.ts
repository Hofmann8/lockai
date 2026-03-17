import { ChatSession, ChatMessage } from '@/types';
import { getAuthState } from './auth';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

function getUserId(): string | null {
  const auth = getAuthState();
  return auth.user?.id || null;
}

export async function getSessions(): Promise<ChatSession[]> {
  const userId = getUserId();
  if (!userId) return [];
  
  try {
    const res = await fetch(`${API_BASE_URL}/api/sessions?user_id=${userId}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((s: any) => ({
      ...s,
      model_id: s.model_id,
      createdAt: new Date(s.created_at),
      updatedAt: new Date(s.updated_at),
      messages: [],
    }));
  } catch {
    return [];
  }
}

export async function getSession(sessionId: string): Promise<ChatSession | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      ...data,
      model_id: data.model_id,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      messages: data.messages.map((m: any) => ({
        ...m,
        images: m.images || undefined,
        tool_trace: Array.isArray(m.tool_trace) ? m.tool_trace : undefined,
        timestamp: new Date(m.timestamp),
      })),
    };
  } catch {
    return null;
  }
}

export async function createSession(modelId?: string): Promise<ChatSession | null> {
  const userId = getUserId();
  if (!userId) return null;
  
  try {
    const res = await fetch(`${API_BASE_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, model_id: modelId }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      ...data,
      model_id: data.model_id,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      messages: [],
    };
  } catch {
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function truncateMessages(sessionId: string, messageId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/truncate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: messageId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function addMessage(sessionId: string, message: ChatMessage): Promise<boolean> {
  console.log('[chat-history] addMessage 开始, sessionId:', sessionId, 'role:', message.role);
  try {
    const res = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: message.id,
        role: message.role,
        content: message.content,
        images: message.images,
        tool_trace: message.tool_trace,
      }),
    });
    console.log('[chat-history] addMessage 响应:', res.status, res.ok);
    return res.ok;
  } catch (e) {
    console.error('[chat-history] addMessage 异常:', e);
    return false;
  }
}

export function generateSessionTitle(messages: ChatMessage[]): string {
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) return '新对话';
  const content = firstUserMsg.content.trim();
  return content.length > 20 ? content.slice(0, 20) + '...' : content;
}
