import {
  ChatModel,
  ChatRequest,
  ChatResponse,
  PaperAssistRequest,
  PaperAssistResponse,
  PaperFileContent,
  PaperFiles,
  PaperGenerateRequest,
  PaperRecord,
  PaperReviseRequest,
  RealtimeAsrEvent,
  RealtimeAsrSessionResponse,
  StreamEvent,
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

/** 获取论文 PDF 代理预览 URL（解决 S3 不支持 inline 预览） */
export function getPaperPdfProxyUrl(paperId: string): string {
  return `${API_BASE_URL}/api/paper/${paperId}/pdf`;
}

export type StreamCallback = (event: StreamEvent) => void;

function parseSSEChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const normalized = buffer.replace(/\r/g, '');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() || '';
  const events: StreamEvent[] = [];

  for (const eventBlock of blocks) {
    if (!eventBlock.trim()) continue;
    const lines = eventBlock.split('\n');
    const dataLines = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
    if (dataLines.length === 0) continue;
    const dataLine = dataLines.join('\n').trim();
    if (!dataLine || dataLine === '[DONE]') continue;

    try {
      events.push(JSON.parse(dataLine) as StreamEvent);
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
      current_message_id: request.current_message_id,
    }),
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    onEvent({ type: 'error', message: errorData.error || '请求失败' });
    return;
  }

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
      current_message_id: request.current_message_id,
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
 * Request AI assistance for paper content
 */
export async function requestPaperAssist(request: PaperAssistRequest): Promise<PaperAssistResponse> {
  const response = await fetch(`${API_BASE_URL}/api/paper/assist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));

    if (response.status === 429) {
      return { result: '', error: 'AI 服务繁忙，请稍后重试' };
    }
    if (response.status === 503) {
      return { result: '', error: 'AI 服务暂时不可用，请稍后重试' };
    }
    if (response.status === 400) {
      return { result: '', error: errorData.error || '请求格式错误' };
    }

    return { result: '', error: errorData.error || '请求失败，请重试' };
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

/**
 * 创建论文规划记录（planning_chat 状态），返回 paper_id
 */
export async function createPaperSession(
  topic: string,
  userId: string,
): Promise<string | null> {
  const response = await fetch(`${API_BASE_URL}/api/paper/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, user_id: userId }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.paper_id || null;
}

/**
 * 保存规划对话消息
 */
export async function savePlanningMessages(
  paperId: string,
  messages: { role: string; content: string }[],
): Promise<void> {
  await fetch(`${API_BASE_URL}/api/paper/${paperId}/planning-messages`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

/**
 * 获取规划对话消息
 */
export async function getPlanningMessages(
  paperId: string,
): Promise<{ role: string; content: string }[]> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}/planning-messages`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.messages || [];
}

/**
 * 提交论文生成任务（后台执行），返回 paper_id
 */
export async function generatePaper(
  request: PaperGenerateRequest,
): Promise<string | null> {
  const response = await fetch(`${API_BASE_URL}/api/paper/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return data.paper_id || null;
}

/**
 * 提交论文修订任务（后台执行），返回是否成功
 */
export async function revisePaper(
  paperId: string,
  request: PaperReviseRequest,
): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}/revise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  return response.ok;
}

/**
 * 从失败阶段恢复生成，返回是否成功
 */
export async function retryPaper(paperId: string): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return response.ok;
}

/**
 * 轮询论文状态
 */
export async function pollPaperStatus(paperId: string): Promise<PaperRecord | null> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}/status`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * 获取论文 VFS 文件列表
 */
export async function getPaperFiles(paperId: string): Promise<PaperFiles | null> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}/files`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * 读取论文 VFS 中的单个文件内容
 */
export async function getPaperFileContent(paperId: string, filePath: string): Promise<PaperFileContent | null> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}/files/${encodeURIComponent(filePath)}`);
  if (!response.ok) return null;
  return response.json();
}

/**
 * 列出用户的所有论文
 */
export async function listPapers(userId: string): Promise<PaperRecord[]> {
  const response = await fetch(`${API_BASE_URL}/api/papers?user_id=${encodeURIComponent(userId)}`);
  if (!response.ok) return [];
  return response.json();
}

/**
 * 删除论文（DB + S3）
 */
export async function deletePaper(paperId: string): Promise<boolean> {
  const response = await fetch(`${API_BASE_URL}/api/paper/${paperId}`, {
    method: 'DELETE',
  });
  return response.ok;
}
