# LockAI

Funk&Love 舞队 AI 平台，提供智能对话、联网搜索、AI 绘图和论文辅助功能。

## 技术栈

- Frontend: Next.js 16 + React 19 + Tailwind CSS 4
- Backend: Flask + SQLAlchemy + SQLite
- AI: Gemini / Grok / Qwen 多模型支持
- Storage: S3 兼容存储（图片）

## 项目结构

```
├── backend/          # Flask 后端
│   ├── app.py        # 主入口
│   ├── models.py     # 数据模型
│   └── services/     # AI 服务模块
│       ├── ai.py     # 服务入口
│       ├── llm.py    # LLM 调用
│       ├── search.py # 联网搜索
│       ├── image.py  # 图像生成
│       └── ...
└── lockai/           # Next.js 前端
    └── src/
        ├── app/      # 页面路由
        ├── components/
        └── lib/
```

## 快速开始

### 后端

```bash
cd backend
conda create -n lockai python=3.11
conda activate lockai
pip install -r requirements.txt
cp .env.example .env  # 配置 API 密钥
python app.py
```

### 前端

```bash
cd lockai
npm install
npm run dev
```

## 功能

- 多角色 AI 对话（小锁老师 / Leo）
- 实时联网搜索
- AI 图像生成
- 论文阅读辅助（解释/总结/翻译）
- 对话历史管理

## License

Private - Funk&Love Internal Use Only
