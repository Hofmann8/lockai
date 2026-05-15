// Chat messages
export interface SearchToolTrace {
  kind: 'search';
  query: string;
  status: 'running' | 'done';
  success?: boolean;
  startedAtMs?: number;
  durationSeconds?: number;
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

export type ToolTrace = SearchToolTrace | ImageGenToolTrace;

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  tool_trace?: ToolTrace[];
  timestamp: Date;
}

// Chat session
export interface ChatSession {
  id: string;
  title: string;
  model_id: string;
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
  paper_id?: string;
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

export interface StreamSearchStartEvent {
  type: 'search_start';
  message_id?: string;
  query: string;
}

export interface StreamSearchEndEvent {
  type: 'search_end';
  message_id?: string;
  query: string;
  success: boolean;
}

export interface StreamImageGenStartEvent {
  type: 'image_gen_start';
  message_id?: string;
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

export interface StreamMessageEndEvent {
  type: 'message_end';
  message_id: string;
}

export interface StreamTitleUpdateEvent {
  type: 'title_update';
  title: string;
}

export interface StreamErrorEvent {
  type: 'error';
  message: string;
}

export type StreamEvent =
  | StreamMessageStartEvent
  | StreamContentDeltaEvent
  | StreamSearchStartEvent
  | StreamSearchEndEvent
  | StreamImageGenStartEvent
  | StreamImageGenEndEvent
  | StreamMessageEndEvent
  | StreamTitleUpdateEvent
  | StreamErrorEvent;

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

// Paper AI assistance
export interface PaperAssistRequest {
  text: string;
  action: 'explain' | 'summarize' | 'translate';
}

export interface PaperAssistResponse {
  result: string;
  error?: string;
}

// Paper state
export interface PaperState {
  latexContent: string;
  pdfFile: File | null;
  currentPage: number;
  totalPages: number;
  zoom: number;
  selectedText: string;
  aiAssistResult: string | null;
  isAiLoading: boolean;
}

// Errors
export interface ErrorResponse {
  error: string;
  code: string;
  details?: string;
}

// Paper generation types
export interface PaperGenerateRequest {
  topic: string;
  user_id?: string;
  design_context?: string;
  paper_id?: string;
}

export interface PaperReviseRequest {
  instruction: string;
}

export interface PaperRecord {
  id: string;
  topic: string;
  status: string;
  pdf_url: string | null;
  progress_detail?: string | null;
  error?: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PaperFiles {
  id: string;
  topic: string;
  files: string[];
}

export interface PaperFileContent {
  path: string;
  content: string;
}
