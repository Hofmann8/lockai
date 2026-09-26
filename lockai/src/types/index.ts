// Chat messages
export interface SearchSource {
  title: string;
  url: string;
  site: string;
  icon?: string;
}

export interface SearchToolTrace {
  kind: 'search';
  query: string;
  /** 非默认引擎的简称（海外 / 新闻 / 权威），默认的中文网页搜索不带 */
  engine?: string;
  /** 模型调工具前说的那句"我去查一下…"，显示在卡片上方 */
  preamble?: string;
  status: 'running' | 'done';
  success?: boolean;
  startedAtMs?: number;
  durationSeconds?: number;
  sources?: SearchSource[];
}

export interface ImageGenRequest {
  subject?: string;
  details?: string;
  style?: string;
  composition?: string;
  camera?: string;
  lighting?: string;
  colorTone?: string;
  background?: string;
  textOverlay?: string;
  negativePrompt?: string;
  prompt?: string;
  imageConfig?: {
    aspectRatio?: string;
    imageSize?: string;
  };
}

export interface ImageEditRequest {
  instruction?: string;
  sourceImageId?: string;
  sourceScope?: 'current_upload' | 'latest_tool_image' | 'latest_user_upload' | 'latest_any';
  sourceHint?: string;
  sourceIndex?: number;
  preserve?: string;
  negativePrompt?: string;
  imageConfig?: {
    aspectRatio?: string;
    imageSize?: string;
  };
}

export interface ImageGenToolTrace {
  kind: 'image_gen';
  preamble?: string;
  assetId?: string;
  mode?: 'generate' | 'edit';
  prompt: string;
  status: 'running' | 'done';
  success?: boolean;
  startedAtMs?: number;
  durationSeconds?: number;
  request?: ImageGenRequest;
  editRequest?: ImageEditRequest;
  resolvedEditRequest?: ImageEditRequest;
  url?: string;
  blurredUrl?: string;
  sourceLabel?: string;
  sourceImageId?: string;
  sourceImageUrl?: string;
  outputWidth?: number;
  outputHeight?: number;
  outputAspectRatio?: string;
  modelLabel?: string;
}

/** 沙箱交付的成品文件 / 用户上传的附件 */
export interface FileArtifact {
  name: string;
  url?: string;
  size: number;
  mime?: string;
  /** 交付的成品：在沙箱 outputs/ 里的相对路径；用户上传的文件夹：在文件夹里的相对路径（沙箱 inputs/ 下同样的位置） */
  path?: string;
  /** Word / PPT 交付时额外转出来的 PDF，网页预览用 */
  preview?: string;
  error?: string;
}

export interface ShellToolTrace {
  kind: 'shell';
  id: string;
  command: string;
  /** 模型给这一步起的简短标题 */
  title?: string;
  preamble?: string;
  status: 'running' | 'done';
  success?: boolean;
  background?: boolean;
  /** 这一步新开了环境（created）或从快照恢复了工作区（restored） */
  env?: 'created' | 'restored';
  output?: string;
  exitCode?: number;
  seconds?: number;
  files?: FileArtifact[];
  previewUrl?: string;
  shown?: number;
  startedAtMs?: number;
  durationSeconds?: number;
  /** 上一步结束到这一步开始之间模型准备它的时间（写命令和正文、等上游）和输出 token，不含思考 */
  prepSeconds?: number;
  prepTokens?: number;
  /** 执行助手做的步骤：属于哪一块派出去的工作（TaskToolTrace.id） */
  taskId?: string;
}

/** 统筹模型派给执行助手的一块工作；执行助手的每一步是带 taskId 的 ShellToolTrace */
export interface TaskToolTrace {
  kind: 'task';
  id: string;
  title: string;
  /** 统筹模型写的任务说明 */
  task: string;
  /** 执行助手的名字（Scooby 2.0） */
  model?: string;
  status: 'running' | 'done';
  success?: boolean;
  /** 执行助手交回的报告 */
  report?: string;
  seconds?: number;
  startedAtMs?: number;
}

export type ToolTrace = SearchToolTrace | ImageGenToolTrace | ShellToolTrace | TaskToolTrace;

export interface ChatMessage {
  id: string;
  /** 流式期间的临时 id；回答结束换成服务端 id 后仍用它做 React key，避免重挂载闪烁 */
  clientKey?: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  files?: FileArtifact[];
  tool_trace?: ToolTrace[];
  /** 思考文字只在停止生成时随消息存档，界面不显示 */
  reasoning?: string;
  reasoning_seconds?: number;
  reasoning_tokens?: number;
  timestamp: Date;
}

// Chat session
export interface ChatSession {
  id: string;
  title: string;
  model_id: string;
  pinned?: boolean;
  /** 这段对话正在后台回答 */
  running?: boolean;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export type ThinkingLevel = 'fast' | 'standard' | 'deep';

export interface ChatModel {
  id: string;
  name: string;
  description: string;
  available: boolean;
  is_default: boolean;
  thinking_mode: 'always' | 'never' | 'optional';
  default_thinking?: boolean;
  tags?: string[];
  supports_reasoning_effort?: boolean;
}

// Chat request/response
export interface ChatRequest {
  message: string;
  images?: string[];
  history?: ChatMessage[];
  model_id?: string;
  user_id?: string;
  session_id?: string;
  thinking?: boolean;
  reasoning_effort?: 'high' | 'max';
  current_message_id?: string;
  image_quality?: 'standard' | 'hd';
  files?: FileArtifact[];
  /** 文档 / 幻灯片的交付偏好 */
  delivery?: 'quality' | 'editable';
  /** 同时回答已满时，用户选了要停下的那段对话 */
  evict?: string;
}

export interface ChatResponse {
  message: string;
  error?: string;
}

export interface RealtimeAsrSessionResponse {
  session_id: string;
  sample_rate: number;
  format: string;
  error?: string;
}

export interface RealtimeAsrEvent {
  type: 'started' | 'partial' | 'final' | 'complete' | 'error' | 'heartbeat';
  text?: string;
  message?: string;
  ts?: number;
  session_id?: string;
}

// Streaming events
export interface StreamMessageStartEvent {
  type: 'message_start';
  message_id: string;
}

export interface StreamContentDeltaEvent {
  type: 'content_delta';
  delta: string;
}

export interface StreamReasoningDeltaEvent {
  type: 'reasoning_delta';
  delta: string;
}

/** 每轮结束后累计的思考用时和思考 token（上游报的，或按思考文字数的） */
export interface StreamReasoningStatsEvent {
  type: 'reasoning_stats';
  seconds: number;
  tokens: number;
}

export interface StreamSearchStartEvent {
  type: 'search_start';
  message_id?: string;
  query: string;
  engine?: string;
  preamble?: string;
}

export interface StreamSearchEndEvent {
  type: 'search_end';
  message_id?: string;
  query: string;
  success: boolean;
  sources?: SearchSource[];
}

export interface StreamImageGenStartEvent {
  type: 'image_gen_start';
  message_id?: string;
  preamble?: string;
  prompt: string;
  mode?: 'generate' | 'edit';
  assetId?: string;
  request?: ImageGenRequest;
  editRequest?: ImageEditRequest;
  modelLabel?: string;
}

export interface StreamImageGenEndEvent {
  type: 'image_gen_end';
  message_id?: string;
  prompt: string;
  mode?: 'generate' | 'edit';
  success: boolean;
  assetId?: string;
  url?: string;
  blurredUrl?: string;
  request?: ImageGenRequest;
  editRequest?: ImageEditRequest;
  resolvedEditRequest?: ImageEditRequest;
  sourceLabel?: string;
  sourceImageId?: string;
  sourceImageUrl?: string;
  outputWidth?: number;
  outputHeight?: number;
  outputAspectRatio?: string;
  modelLabel?: string;
}

export interface StreamTaskStartEvent {
  type: 'task_start';
  id: string;
  title: string;
  task: string;
  model?: string;
}

export interface StreamTaskEndEvent {
  type: 'task_end';
  id: string;
  success: boolean;
  report?: string;
  seconds?: number;
}

export interface StreamShellStartEvent {
  type: 'shell_start';
  message_id?: string;
  id: string;
  command: string;
  title?: string;
  taskId?: string;
  background?: boolean;
  preamble?: string;
  prepSeconds?: number;
  prepTokens?: number;
}

export interface StreamShellEnvEvent {
  type: 'shell_env';
  id: string;
  state: 'created' | 'restored';
}

export interface StreamShellOutputEvent {
  type: 'shell_output';
  id: string;
  delta: string;
}

export interface StreamShellEndEvent {
  type: 'shell_end';
  id: string;
  success: boolean;
  output?: string;
  exitCode?: number;
  seconds?: number;
  files?: FileArtifact[];
  previewUrl?: string;
  shown?: number;
}

export interface StreamMessageEndEvent {
  type: 'message_end';
  message_id: string;
  /** 中途停下的原因：user 用户停止 / evicted 被新回答挤掉 / timeout 超时 / discard / deleted */
  stopped?: string;
}

/** 回到正在后台回答的会话：先重放已有事件（resume … replay_done），再接实时的 */
export interface StreamResumeEvent {
  type: 'resume';
  /** 这一轮开始的时间（毫秒时间戳） */
  started_at: number;
  /** 服务端当前时间，用来把事件时间戳换算到本机时钟 */
  now: number;
}

export interface StreamReplayDoneEvent {
  type: 'replay_done';
}

/** 给用户的提示，比如同时回答的对话太多、有一条被停下了 */
export interface StreamNoticeEvent {
  type: 'notice';
  message: string;
}

export interface StreamTitleUpdateEvent {
  type: 'title_update';
  title: string;
}

export interface StreamErrorEvent {
  type: 'error';
  message: string;
  code?: string;
}

export type StreamEvent =
  | StreamMessageStartEvent
  | StreamContentDeltaEvent
  | StreamReasoningDeltaEvent
  | StreamReasoningStatsEvent
  | StreamSearchStartEvent
  | StreamSearchEndEvent
  | StreamImageGenStartEvent
  | StreamImageGenEndEvent
  | StreamShellStartEvent
  | StreamShellEnvEvent
  | StreamShellOutputEvent
  | StreamShellEndEvent
  | StreamTaskStartEvent
  | StreamTaskEndEvent
  | StreamMessageEndEvent
  | StreamTitleUpdateEvent
  | StreamResumeEvent
  | StreamReplayDoneEvent
  | StreamNoticeEvent
  | StreamErrorEvent;

/** 后台回答的事件都带服务端时间戳，重放时用它还原各步的起止时间 */
export type TimedStreamEvent = StreamEvent & { ts?: number };

// Auth state
export interface AuthState {
  isAuthenticated: boolean;
  user?: {
    id?: string;
    name: string;
    email: string;
    avatarUrl?: string;
  };
}

// Chat page state
export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
}

// Errors
export interface ErrorResponse {
  error: string;
  code: string;
  details?: string;
}
