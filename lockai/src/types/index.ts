// 聊天消息
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// 对话会话
export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

// 聊天请求
export interface ChatRequest {
  message: string;
  history?: ChatMessage[];
  user_id?: string;
  session_id?: string;
}

// 聊天响应
export interface ChatResponse {
  message: string;
  error?: string;
}

// 论文 AI 辅助请求
export interface PaperAssistRequest {
  text: string;
  action: 'explain' | 'summarize' | 'translate';
}

// 论文 AI 辅助响应
export interface PaperAssistResponse {
  result: string;
  error?: string;
}

// 认证状态
export interface AuthState {
  isAuthenticated: boolean;
  user?: {
    id?: string;
    name: string;
    email: string;
  };
}

// 聊天状态
export interface ChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string | null;
}

// 论文状态
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

// 错误响应格式
export interface ErrorResponse {
  error: string;
  code: string;
  details?: string;
}
