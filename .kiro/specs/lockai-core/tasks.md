# Implementation Plan: LockAI Core

## Overview

实现 LockAI 核心功能，包括认证、聊天和论文三大模块。采用 Next.js 前端 + Flask 后端架构，集成 Gemini AI。

## Tasks

- [x] 1. 项目基础设置
  - [x] 1.1 配置 Next.js 项目结构和路由
    - 创建 app/chat/page.tsx 和 app/paper/page.tsx 路由
    - 配置 Tailwind CSS 主题色和品牌样式
    - 添加 favicon 和 logo 资源
    - _Requirements: 8.1, 8.4_
  
  - [x] 1.2 安装前端依赖
    - 安装 react-pdf 用于 PDF 渲染
    - 安装 katex 和 react-katex 用于 LaTeX 渲染
    - 安装 lucide-react 用于图标
    - _Requirements: 4.1, 5.1_
  
  - [x] 1.3 创建 TypeScript 类型定义
    - 定义 ChatMessage, ChatRequest, ChatResponse 接口
    - 定义 PaperAssistRequest, PaperAssistResponse 接口
    - 定义 AuthState 接口
    - _Requirements: 3.2, 6.2, 1.1_

- [x] 2. 认证模块实现
  - [x] 2.1 实现登录页面 UI
    - 创建现代化登录页面，包含 Funk&Love logo
    - 实现 LockAuth SSO 登录按钮 (mock)
    - 添加品牌元素和动画效果
    - _Requirements: 1.1, 8.1, 8.5_
  
  - [x] 2.2 实现认证状态管理
    - 创建 lib/auth.ts 管理认证状态
    - 使用 localStorage 存储 mock 认证状态
    - 实现登录/登出函数
    - _Requirements: 1.2, 1.4_
  
  - [x] 2.3 实现路由保护
    - 创建认证检查中间件或 HOC
    - 未认证用户重定向到登录页
    - _Requirements: 1.3_
  
  - [ ]* 2.4 编写路由保护属性测试
    - **Property 1: Route Protection**
    - **Validates: Requirements 1.3**

- [x] 3. 导航栏组件实现
  - [x] 3.1 实现 Navbar 组件
    - 创建 components/Navbar.tsx
    - 包含 Chat 和 Paper 导航链接
    - 显示当前活动模块高亮
    - 实现响应式设计 (移动端汉堡菜单)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  
  - [ ]* 3.2 编写导航路由属性测试
    - **Property 2: Navigation Routing Consistency**
    - **Validates: Requirements 2.2, 2.3**

- [ ] 4. Checkpoint - 基础架构验证
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 聊天模块前端实现
  - [x] 5.1 实现聊天容器组件
    - 创建 components/chat/ChatContainer.tsx
    - 管理聊天状态 (messages, isLoading, error)
    - _Requirements: 3.1, 3.6_
  
  - [x] 5.2 实现消息列表组件
    - 创建 components/chat/MessageList.tsx
    - 创建 components/chat/Message.tsx
    - 区分用户消息和 AI 消息样式
    - 支持 Markdown 渲染
    - _Requirements: 3.4_
  
  - [x] 5.3 实现消息输入组件
    - 创建 components/chat/MessageInput.tsx
    - 支持 Enter 发送和 Shift+Enter 换行
    - 显示发送按钮和加载状态
    - _Requirements: 3.2, 3.5_
  
  - [x] 5.4 实现 API 客户端
    - 创建 lib/api.ts
    - 实现 sendChatMessage 函数
    - 处理错误响应
    - _Requirements: 3.2, 3.7_
  
  - [ ]* 5.5 编写聊天消息属性测试
    - **Property 3: Chat Message Round-Trip**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.6, 3.7**

- [x] 6. 论文模块 - LaTeX 编辑器实现
  - [x] 6.1 实现 LaTeX 编辑器组件
    - 创建 components/paper/LatexEditor.tsx
    - 实现代码编辑区域
    - _Requirements: 4.4_
  
  - [x] 6.2 实现 LaTeX 预览组件
    - 创建 components/paper/LatexPreview.tsx
    - 使用 KaTeX 实时渲染
    - 处理渲染错误
    - _Requirements: 4.1, 4.2, 4.3_
  
  - [ ]* 6.3 编写 LaTeX 渲染属性测试
    - **Property 4: LaTeX Rendering Correctness**
    - **Validates: Requirements 4.1, 4.2, 4.3**

- [-] 7. 论文模块 - PDF 阅读器实现
  - [ ] 7.1 实现 PDF 查看器组件
    - 创建 components/paper/PdfViewer.tsx
    - 使用 react-pdf 渲染 PDF
    - 实现文件上传功能
    - _Requirements: 5.1_
  
  - [ ] 7.2 实现 PDF 导航控制
    - 添加上一页/下一页按钮
    - 添加页码跳转输入
    - 显示当前页/总页数
    - _Requirements: 5.2, 5.4_
  
  - [ ] 7.3 实现 PDF 缩放控制
    - 添加放大/缩小按钮
    - 添加适应宽度按钮
    - _Requirements: 5.3_
  
  - [ ]* 7.4 编写 PDF 查看器属性测试
    - **Property 5: PDF Viewer State Consistency**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

- [x] 8. 论文模块 - AI 辅助实现
  - [x] 8.1 实现文本选择功能
    - 监听 PDF 文本选择事件
    - 显示 AI 辅助选项菜单
    - _Requirements: 6.1_
  
  - [x] 8.2 实现 AI 辅助面板
    - 创建 components/paper/AiAssistPanel.tsx
    - 显示 AI 解释结果
    - 支持解释、总结、翻译操作
    - _Requirements: 6.3_
  
  - [x] 8.3 实现 AI 辅助 API 调用
    - 在 lib/api.ts 添加 requestPaperAssist 函数
    - _Requirements: 6.2_
  
  - [ ]* 8.4 编写 AI 辅助属性测试
    - **Property 6: AI Assist Round-Trip**
    - **Validates: Requirements 6.2, 6.3**

- [ ] 9. Checkpoint - 前端功能验证
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Flask 后端实现
  - [x] 10.1 创建 Flask 项目结构
    - 创建 backend/ 目录
    - 创建 app.py 主文件
    - 创建 requirements.txt
    - 配置 CORS
    - _Requirements: 7.1, 7.2_
  
  - [x] 10.2 实现 Gemini 服务
    - 创建 backend/services/gemini.py
    - 实现 Gemini API 调用
    - 处理速率限制
    - _Requirements: 3.3, 7.5, 7.6_
  
  - [x] 10.3 实现聊天 API 端点
    - 实现 POST /api/chat
    - 请求验证
    - 错误处理
    - _Requirements: 7.1, 7.3, 7.4_
  
  - [x] 10.4 实现论文辅助 API 端点
    - 实现 POST /api/paper/assist
    - 请求验证
    - 错误处理
    - _Requirements: 7.2, 7.3, 7.4_
  
  - [ ]* 10.5 编写后端请求验证属性测试
    - **Property 7: Backend Request Validation**
    - **Validates: Requirements 7.3, 7.4**

- [x] 11. 论文页面整合
  - [x] 11.1 创建论文页面容器
    - 创建 components/paper/PaperContainer.tsx
    - 整合 LaTeX 编辑器、PDF 阅读器和 AI 辅助面板
    - 实现标签页切换 (LaTeX / PDF)
    - _Requirements: 4.4, 5.1, 6.1_

- [x] 12. UI/UX 优化
  - [x] 12.1 实现深色模式
    - 配置 Tailwind 深色模式
    - 添加主题切换按钮
    - _Requirements: 8.3_
  
  - [x] 12.2 添加过渡动画
    - 页面切换动画
    - 组件加载动画
    - 交互反馈动画
    - _Requirements: 8.5_

- [ ] 13. Final Checkpoint - 完整功能验证
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties
- Unit tests validate specific examples and edge cases
- 使用 conda 环境 `lockai` 运行 Flask 后端
