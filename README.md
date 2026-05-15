# LockAI

Funk&Love 舞队 AI 平台。多角色对话、联网搜索、AI 绘图 / 修图 / 识图、语音输入、论文辅助。

当前版本：**0.8**

## 技术栈

- **Frontend**：Next.js 16 + React 19 + Tailwind CSS 4，React Compiler 启用
- **Backend**：Flask + SQLAlchemy + SQLite
- **AI Providers**：Anthropic（Campbell / claude-sonnet-4-6）、DeepSeek（Scooby / Leo）、Qwen（联网搜索 / 视觉 / ASR）、Gemini & gpt-image-2（绘图）
- **Storage**：Bitiful S3（图片 + 服务端 SVG 水印）

## 项目结构

```
├── backend/                # Flask 后端
│   ├── app.py              # 主入口
│   ├── models.py           # 数据模型（含 CampbellUsage 限额表）
│   ├── models.json         # 模型注册表（前台可见 + 内部模型）
│   └── services/
│       ├── ai.py           # 服务入口
│       ├── llm.py          # 多 provider LLM 调用
│       ├── provider_runtime.py
│       ├── tool_contracts.py
│       ├── prompts.py
│       ├── search.py       # 联网搜索
│       ├── image.py        # 图像生成 / 修图（S3 + 水印）
│       ├── asr.py          # 实时语音识别
│       ├── usage.py        # Campbell 日 / 月配额
│       ├── title.py        # 自动会话标题
│       ├── storage.py
│       ├── paper/          # 论文辅助流水线
│       └── terminal/
└── lockai/                 # Next.js 前端
    ├── public/
    │   └── watermark.svg   # 服务端水印（已上传 S3 为 public/watermark2.svg）
    └── src/
        ├── app/(app)/chat/
        ├── components/     # AppShell, SettingsModal, chat/*
        └── lib/            # api, settings, theme, hooks, markdown
```

## 模型角色

| ID       | 名称        | 后端模型            | 说明 |
| -------- | ----------- | ------------------- | ---- |
| campbell | Campbell 2.0 | claude-sonnet-4-6   | 深度推理；有日 / 月配额 |
| scooby   | Scooby 2.0   | deepseek-v4-pro     | 通用助理，免费 |
| leo      | Leo 2.0      | deepseek-v4-flash   | 轻量快速，免费 |

所有角色均可触发联网搜索、绘图（Campbell 1.5 / 2.0 Image）、识图、修图。绘图统一消耗 Campbell 配额。

## 快速开始

### 后端

```bash
cd backend
conda create -n lockai python=3.11
conda activate lockai
pip install -r requirements.txt
cp .env.example .env   # 配置 API 密钥
python app.py
```

### 前端

```bash
cd lockai
npm install
npm run dev
```

## 部署

根目录 `deploy.py` 打包前后端为 `dist/lockai-backend.zip` 与 `dist/lockai-frontend.zip`。Gunicorn 配置见 [backend/gunicorn.conf.py](backend/gunicorn.conf.py)。

## License

Private — Funk&Love Internal Use Only
