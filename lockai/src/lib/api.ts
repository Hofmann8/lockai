import {
  ChatModel,
  ChatRequest,
  ChatResponse,
  FileArtifact,
  RealtimeAsrEvent,
  RealtimeAsrSessionResponse,
  TimedStreamEvent,
} from '@/types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

/**
 * 上传图片到 S3，返回公开 URL
 */
export async function uploadImage(
  base64DataUrl: string,
  userId?: string,
  sessionId?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/upload-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64DataUrl,
        user_id: userId,
        session_id: sessionId,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}

/**
 * 上传任意附件（文档、表格、音视频…），给沙箱处理。返回 {name, path?, url, size, mime}
 * path 是文件夹上传时在文件夹里的相对路径，沙箱 inputs/ 里按它还原目录结构。
 */
export async function uploadFile(file: File, userId?: string, sessionId?: string, path?: string): Promise<FileArtifact | null> {
  try {
    const form = new FormData();
    form.append('file', file, file.name);
    if (userId) form.append('user_id', userId);
    if (sessionId) form.append('session_id', sessionId);
    if (path) form.append('path', path);
    const res = await fetch(`${API_BASE_URL}/api/upload-file`, { method: 'POST', body: form });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url ? (data as FileArtifact) : null;
  } catch {
    return null;
  }
}

export async function getModels(): Promise<ChatModel[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/models`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.models) ? data.models : [];
  } catch {
    return [];
  }
}

export interface CampbellUsage {
  today: { day: string; chat_calls: number; image_calls: number; units: number; credits: number };
  month: { month: string; chat_calls: number; image_calls: number; units: number; credits: number };
  limits: { daily: number; monthly: number; tokens_per_credit: number; image_min_credits: number };
  remaining: { daily: number; monthly: number };
}

export async function getUsage(userId: string): Promise<CampbellUsage | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/usage?user_id=${encodeURIComponent(userId)}`);
    if (!res.ok) return null;
    return (await res.json()) as CampbellUsage;
  } catch {
    return null;
  }
}

export async function createRealtimeAsrSession(): Promise<RealtimeAsrSessionResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/asr/sessions`, {
      method: 'POST',
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        session_id: '',
        sample_rate: 16000,
        format: 'pcm',
        error: errorData.error || '创建实时语音会话失败',
      };
    }
    return response.json();
  } catch {
    return {
      session_id: '',
      sample_rate: 16000,
      format: 'pcm',
      error: '创建实时语音会话失败，请检查网络后重试',
    };
  }
}

export async function pushRealtimeAsrAudio(sessionId: string, audioChunk: ArrayBuffer): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/asr/sessions/${sessionId}/audio`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: audioChunk,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || '上传语音分片失败');
  }
}

export async function cancelRealtimeAsrSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/asr/sessions/${sessionId}/cancel`, {
    method: 'POST',
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || '关闭实时语音会话失败');
  }
}

export function getRealtimeAsrStreamUrl(sessionId: string): string {
  return `${API_BASE_URL}/api/asr/sessions/${sessionId}/stream?history=1`;
}

export function parseRealtimeAsrEvent(eventData: MessageEvent<string>): RealtimeAsrEvent | null {
  try {
    return JSON.parse(eventData.data) as RealtimeAsrEvent;
  } catch {
    return null;
  }
}

/** 根据最后一轮问答要 3 条追问建议；失败时返回空数组 */
export async function fetchSuggestions(userMessage: string, assistantMessage: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/chat/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_message: userMessage, assistant_message: assistantMessage }),
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.suggestions) ? data.suggestions.filter((s: unknown) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export type StreamCallback = (event: TimedStreamEvent) => void;

function parseSSEChunk(buffer: string): { events: TimedStreamEvent[]; rest: string } {
  const normalized = buffer.replace(/\r/g, '');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() || '';
  const events: TimedStreamEvent[] = [];

  for (const eventBlock of blocks) {
    if (!eventBlock.trim()) continue;
    const lines = eventBlock.split('\n');
    const dataLines = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
    if (dataLines.length === 0) continue;
    const dataLine = dataLines.join('\n').trim();
    if (!dataLine || dataLine === '[DONE]') continue;

    try {
      events.push(JSON.parse(dataLine) as TimedStreamEvent);
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

/**
 * 流式发送聊天消息
 */
export async function sendChatMessageStream(
  request: ChatRequest,
  onEvent: StreamCallback,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: request.message,
      images: request.images,
      files: request.files,
      history: request.history?.map((msg) => ({
        role: msg.role,
        content: msg.content,
        images: msg.images,
        files: msg.files,
        tool_trace: msg.tool_trace,
      })),
      model_id: request.model_id,
      user_id: request.user_id,
      session_id: request.session_id,
      thinking: request.thinking,
      reasoning_effort: request.reasoning_effort,
      current_message_id: request.current_message_id,
      image_quality: request.image_quality,
      delivery: request.delivery,
      evict: request.evict,
    }),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    onEvent({ type: 'error', message: errorData.error || '请求失败' });
    return;
  }
  await readEventStream(response, onEvent);
}

/** 逐条读出 SSE 事件 */
async function readEventStream(response: Response, onEvent: StreamCallback): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    onEvent({ type: 'error', message: '无法读取响应' });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: true });
    }

    const { events, rest } = parseSSEChunk(buffer);
    buffer = rest;

    for (const event of events) {
      onEvent(event);
    }

    if (done) break;
  }

  reader.releaseLock();

  if (buffer.trim()) {
    const { events } = parseSSEChunk(`${buffer}\n\n`);
    for (const event of events) {
      onEvent(event);
    }
  }
}

/**
 * 接上一段正在后台回答的对话：先重放已有的事件（resume … replay_done），再接实时的。
 * 这段对话已经没有在回答时返回 false。
 */
export async function resumeChatStream(sessionId: string, onEvent: StreamCallback, signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/api/chat/runs/${sessionId}/events`, { signal });
  if (response.status === 404) return false;
  if (!response.ok) {
    onEvent({ type: 'error', message: '没能接上正在进行的回答' });
    return true;
  }
  await readEventStream(response, onEvent);
  return true;
}

/** 停止正在后台回答的对话；discard 时连已写的部分也不保存（重新生成、编辑前用） */
export async function stopChatRun(sessionId: string, discard = false): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/api/chat/runs/${sessionId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discard }),
      keepalive: true,
    });
  } catch {
    // 没停下来也不要紧：回答做完照样落库
  }
}

export interface RunningChat {
  session_id: string;
  title: string;
  /** 开始时间（毫秒时间戳） */
  started_at: number;
}

/** 正在后台回答的对话（跑得最久的在前）和同时回答的上限 */
export async function getRunningChats(userId: string): Promise<{ limit: number; runs: RunningChat[] }> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/chat/runs?user_id=${encodeURIComponent(userId)}`);
    if (!res.ok) return { limit: 3, runs: [] };
    return await res.json();
  } catch {
    return { limit: 3, runs: [] };
  }
}

/**
 * Send a chat message to the backend (非流式，保留兼容)
 */
export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: request.message,
      images: request.images,
      history: request.history?.map((msg) => ({
        role: msg.role,
        content: msg.content,
        images: msg.images,
        tool_trace: msg.tool_trace,
      })),
      model_id: request.model_id,
      user_id: request.user_id,
      session_id: request.session_id,
      thinking: request.thinking,
      reasoning_effort: request.reasoning_effort,
      current_message_id: request.current_message_id,
      image_quality: request.image_quality,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));

    if (response.status === 429) {
      return { message: '', error: 'AI 服务繁忙，请稍后重试' };
    }
    if (response.status === 503) {
      return { message: '', error: 'AI 服务暂时不可用，请稍后重试' };
    }
    if (response.status === 400) {
      return { message: '', error: errorData.error || '请求格式错误' };
    }

    return { message: '', error: errorData.error || '发送消息失败，请重试' };
  }

  return response.json();
}

/**
 * 生成会话标题
 */
export async function generateSessionTitle(
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}/generate-title`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_message: userMessage,
        assistant_message: assistantMessage,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      return data.title;
    }
  } catch (e) {
    console.error('[API] 生成标题失败:', e);
  }
  return null;
}
