import type { ChatMessage, ImageGenToolTrace, SearchSource, ShellToolTrace, TaskToolTrace, ToolTrace } from '@/types';

export const TOOL_MARKER_RE = /<!--tool:(\d+)-->/g;

/**
 * 工具开始时，把正文末尾刚流出来的那句说明（后端在开始事件里带回来的原文）收走，交给工具卡片。
 * 末尾对不上就原样不动，宁可留在正文里也不误删。
 */
export function takePreamble(content: string, preamble?: string): { content: string; preamble?: string } {
  const text = preamble?.trim();
  if (!text) return { content };
  const body = content.replace(/\s+$/, '');
  if (!body.endsWith(text)) return { content };
  return { content: body.slice(0, body.length - text.length).replace(/\s+$/, ''), preamble: text };
}

export function findLatestRunningToolTraceIndex(trace: ToolTrace[] | undefined, kind: ToolTrace['kind']): number {
  if (!Array.isArray(trace)) return -1;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const item = trace[i];
    if (item.kind === kind && item.status === 'running') return i;
  }
  return -1;
}

export function upsertRunningSearchTrace(
  trace: ToolTrace[] | undefined,
  query: string,
  engine?: string,
  preamble?: string,
  at = Date.now(),
): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  const last = next[next.length - 1];
  if (last && last.kind === 'search' && last.status === 'running') {
    next[next.length - 1] = { ...last, query: query.trim() || last.query, engine: engine || last.engine, preamble: preamble || last.preamble };
    return next;
  }
  next.push({
    kind: 'search',
    query: query.trim(),
    ...(engine ? { engine } : {}),
    ...(preamble ? { preamble } : {}),
    status: 'running',
    startedAtMs: at,
  });
  return next;
}

export function finalizeSearchTrace(
  trace: ToolTrace[] | undefined,
  query: string,
  success: boolean,
  sources?: SearchSource[],
  at = Date.now(),
): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const item = next[i];
    if (item.kind === 'search' && item.status === 'running') {
      const startedAtMs = item.startedAtMs ?? at;
      next[i] = {
        ...item,
        query: query.trim() || item.query,
        status: 'done',
        success,
        sources: sources && sources.length > 0 ? sources : item.sources,
        durationSeconds: Math.max(1, Math.round((at - startedAtMs) / 1000)),
      };
      return next;
    }
  }
  next.push({ kind: 'search', query: query.trim(), status: 'done', success, sources, durationSeconds: 1 });
  return next;
}

export function upsertRunningImageTrace(
  trace: ToolTrace[] | undefined,
  patch: Partial<ImageGenToolTrace> & { prompt: string },
  at = Date.now(),
): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  const last = next[next.length - 1];
  if (last && last.kind === 'image_gen' && last.status === 'running') {
    next[next.length - 1] = { ...last, ...patch };
    return next;
  }
  next.push({ kind: 'image_gen', ...patch, status: 'running', startedAtMs: at, prompt: patch.prompt, mode: patch.mode });
  return next;
}

export function patchLatestImageTrace(
  trace: ToolTrace[] | undefined,
  patch: Partial<ImageGenToolTrace>,
  at = Date.now(),
): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].kind === 'image_gen') {
      const existing = next[i] as ImageGenToolTrace;
      const startedAtMs = existing.startedAtMs ?? at;
      next[i] = {
        ...existing,
        ...patch,
        durationSeconds: patch.status === 'done'
          ? Math.max(1, Math.round((at - startedAtMs) / 1000))
          : existing.durationSeconds,
      } as ImageGenToolTrace;
      return next;
    }
  }
  return next;
}

/** 界面上最多保留多少字的实时输出（完整输出模型那边有） */
const SHELL_OUTPUT_KEEP = 20000;

export function startShellTrace(
  trace: ToolTrace[] | undefined,
  step: {
    id: string;
    command: string;
    title?: string;
    background?: boolean;
    preamble?: string;
    output?: string;
    prepSeconds?: number;
    prepTokens?: number;
    /** 接上后台回答重放时，用服务端记下的开始时间 */
    startedAtMs?: number;
    taskId?: string;
  },
): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  next.push({
    kind: 'shell',
    id: step.id,
    command: step.command,
    ...(step.title ? { title: step.title } : {}),
    ...(step.taskId ? { taskId: step.taskId } : {}),
    ...(step.background ? { background: true } : {}),
    ...(step.preamble ? { preamble: step.preamble } : {}),
    ...(step.prepSeconds !== undefined ? { prepSeconds: step.prepSeconds } : {}),
    ...(step.prepTokens !== undefined ? { prepTokens: step.prepTokens } : {}),
    output: step.output ?? '',
    status: 'running',
    startedAtMs: step.startedAtMs ?? Date.now(),
  });
  return next;
}

export function patchShellTrace(
  trace: ToolTrace[] | undefined,
  id: string,
  patch: (step: ShellToolTrace) => Partial<ShellToolTrace>,
): ToolTrace[] | undefined {
  if (!Array.isArray(trace)) return trace;
  const idx = trace.findIndex((t) => t.kind === 'shell' && t.id === id);
  if (idx < 0) return trace;
  const next = [...trace];
  const step = next[idx] as ShellToolTrace;
  next[idx] = { ...step, ...patch(step) };
  return next;
}

export function startTaskTrace(
  trace: ToolTrace[] | undefined,
  task: { id: string; title: string; task: string; model?: string; startedAtMs: number },
): ToolTrace[] {
  const next = Array.isArray(trace) ? [...trace] : [];
  next.push({ kind: 'task', ...task, status: 'running' });
  return next;
}

export function patchTaskTrace(
  trace: ToolTrace[] | undefined,
  id: string,
  patch: (task: TaskToolTrace) => Partial<TaskToolTrace>,
): ToolTrace[] | undefined {
  if (!Array.isArray(trace)) return trace;
  const idx = trace.findIndex((t) => t.kind === 'task' && t.id === id);
  if (idx < 0) return trace;
  const next = [...trace];
  const task = next[idx] as TaskToolTrace;
  next[idx] = { ...task, ...patch(task) };
  return next;
}

export function appendShellOutput(step: ShellToolTrace, delta: string): Partial<ShellToolTrace> {
  const output = `${step.output ?? ''}${delta}`;
  return { output: output.length > SHELL_OUTPUT_KEEP ? output.slice(-SHELL_OUTPUT_KEEP) : output };
}

export function finalizeInterruptedToolTrace(trace: ToolTrace[] | undefined): ToolTrace[] | undefined {
  if (!Array.isArray(trace) || trace.length === 0) return trace;
  let changed = false;
  const next = trace.map((item) => {
    if (item.status !== 'running') return item;
    changed = true;
    return { ...item, status: 'done', success: false } as ToolTrace;
  });
  return changed ? next : trace;
}

export function appendToolMarker(content: string, toolIndex: number): string {
  const marker = `<!--tool:${toolIndex}-->`;
  return content.includes(marker) ? content : `${content}${marker}`;
}

export function stripToolMarkers(content: string): string {
  return (content || '').replace(TOOL_MARKER_RE, '').trim();
}

/** 回答内容被工具调用切成的片段：文字段和工具卡片交替出现 */
export type AssistantPart = { type: 'text'; value: string } | { type: 'tool'; traceIdx: number };

export function splitAssistantParts(content: string, toolTrace: ToolTrace[]): AssistantPart[] {
  const parts: AssistantPart[] = [];
  const markerRe = /<!--tool:(\d+)-->/g;
  let lastIndex = 0;
  let matched = false;
  let match: RegExpExecArray | null = null;
  while ((match = markerRe.exec(content)) !== null) {
    matched = true;
    const segment = content.slice(lastIndex, match.index);
    if (segment.trim()) parts.push({ type: 'text', value: segment });
    parts.push({ type: 'tool', traceIdx: Number(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  const tail = content.slice(lastIndex);
  if (tail.trim()) parts.push({ type: 'text', value: tail });
  if (!matched && toolTrace.length > 0) {
    const rebuilt: AssistantPart[] = [];
    if (content.trim()) rebuilt.push({ type: 'text', value: content });
    toolTrace.forEach((_, index) => rebuilt.push({ type: 'tool', traceIdx: index }));
    return rebuilt;
  }
  return parts;
}

/** 工具已经结束，但模型还没接着写字：这段时间要显示"正在整理结果" */
export function isAwaitingToolFollowup(message: ChatMessage | null): boolean {
  if (!message || message.role !== 'assistant') return false;
  const trace = message.tool_trace ?? [];
  if (trace.length === 0 || trace.some((item) => item.status === 'running')) return false;
  const content = message.content || '';
  const markerRe = /<!--tool:(\d+)-->/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = null;
  while ((match = markerRe.exec(content)) !== null) lastMatch = match;
  if (!lastMatch) return !content.trim();
  return !content.slice(lastMatch.index + lastMatch[0].length).trim();
}
