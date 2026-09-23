# LockAI

Funk&Love 舞队 AI 平台。多角色对话、联网搜索、AI 绘图 / 修图 / 识图、语音输入。

当前版本：**0.9**

## 技术栈

- **Frontend**：Next.js 16 + React 19 + Tailwind CSS 4，React Compiler 启用；动画用 GSAP（`@gsap/react`），登录页 / 空状态的 3D 锁是一个手写 WebGL 着色器（无 three.js）
- **Backend**：FastAPI + SQLAlchemy 2 + SQLite，生产用 gunicorn + uvicorn worker
- **AI Providers**：RelayRouter（Campbell / gpt-6-astra，绘图 / 修图，联网搜索）、DeepSeek（Scooby / deepseek-flash，标题 / 追问建议 / 识图转述）、DashScope（仅语音识别）
- **Storage**：Bitiful S3（图片 + 服务端 SVG 水印）

## 项目结构

```
├── backend/                # FastAPI 后端
│   ├── app.py              # 路由与启动（python app.py）
│   ├── asgi.py             # 生产入口（gunicorn -c gunicorn.conf.py asgi:app）
│   ├── database.py         # 数据库层，按请求 / 后台线程隔离会话
│   ├── schemas.py          # 请求体模型（Pydantic），同时生成 /docs
│   ├── sse.py              # SSE 工具：同步生成器放后台线程，断开即停
│   ├── models.py           # 数据模型（含 CampbellUsage 限额表）
│   ├── models.json         # 模型注册表（前台可见 + 内部模型，billable 标记计费模型）
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
│       ├── event_bus.py    # 实时语音识别的事件分发
│       └── storage.py
└── lockai/                 # Next.js 前端
    ├── public/
    │   └── watermark.svg   # 服务端水印（已上传 S3 为 public/watermark2.svg）
    └── src/
        ├── app/(app)/chat/
        ├── components/
        │   ├── AppShell.tsx        # 外壳：会话列表、全局快捷键、删除撤销
        │   ├── brand/              # LockMark（SVG 锁标）、LockOrb（WebGL 3D 锁）
        │   ├── shell/              # 侧栏、命令面板、设置、快捷键
        │   ├── chat/               # ChatView、消息、输入框、Markdown、工具卡片、划词、顺便问
        │   └── ui/                 # Popover / Tooltip / Dialog / Toast
        └── lib/
            ├── chat/               # useChatController（流式状态机）、traces、compose、export
            └── api, settings, theme, clipboard, hooks, markdown
```

### 前端交互（0.9）

- 发送后新问题顶到视口上沿，回答在下面长出；停在底部时自动跟随，往上翻就不打扰，右下出现"回到最新"
- 流式逐词淡入；思考过程实时展开、结束后折叠成"思考了 N 秒"；联网搜索显示来源
- 回答：复制（保留格式 / Markdown）、重新回答（可换模型）、从这里分支出新对话、追问建议
- 问题：编辑后重发（输入框为空时按 ↑ 编辑上一条）
- 回答中继续输入：Enter 排队，⌘/Ctrl+Enter 打断并按新方向重来
- 划词：引用到输入框 / 顺便问（侧边小窗，不写进当前对话）/ 复制
- 输入框：粘贴或拖入图片、超长粘贴自动收成附件、语音输入、模型与思考强度切换
- 表格一键复制 Markdown / 下载 CSV，代码块复制 / 换行，整段对话导出 Markdown
- 侧栏：置顶、按日期分组、重命名、删除可撤销、可收起成窄栏；⌘K 命令面板，⌘/ 查看全部快捷键

## 模型角色

| ID       | 名称        | 后端模型            | 说明 |
| -------- | ----------- | ------------------- | ---- |
| campbell | Campbell 3.0 | gpt-6-astra         | 深度推理；有日 / 月配额 |
| scooby   | Scooby 2.0   | deepseek-flash      | 通用助理，响应快，免费 |

Leo 已于 0.8 下线，历史会话在后端启动时自动并入 Scooby。DeepSeek 的 `deepseek-v4-flash`
是指向 `deepseek-flash` 的旧别名，新配置一律写 `deepseek-flash`。

两个角色均可触发联网搜索、绘图（Campbell 2.5 / 3.0 Image）、识图、修图。绘图统一消耗 Campbell 配额。

联网搜索：DeepSeek 自己不能上网，`web_search` 工具由 RelayRouter 的 `gpt-4.1-mini`（Responses API + `web_search`）代搜，按次计费。
每次回答最多真搜 4 次，最后一轮不再给工具、强制作答；系统提示词里带北京时间的当前日期，避免模型拿错年份去搜。

识图：`models.json` 里 `"vision": true` 的模型直接看图（Campbell、Scooby 都是）；否则先由 `image_describer`（deepseek-flash）转述成文字。

绘图模型：Campbell 2.5 Image 为 `gpt-image-2.5-flare`（出图较快），Campbell 3.0 Image 为 `gpt-image-2.5-sunburst`（高清，出图较慢）。两者与 Campbell 主模型同走 RelayRouter，共用 `RELAY_API_KEY`。

## 身份保护

Campbell 走的中转通道会在更早的位置注入自己的产品人设，只在开头放身份提示词压不住它，
中英文越权提问都会漏出底层模型名。所以 `models.json` 里给前台模型加了 `identity_guard`，
后端在每轮消息列表**末尾**再追加一条身份提醒（`services/prompts.py` 的 `get_identity_reminder`）。
内部模型（标题生成、搜索、识图）不加，避免污染输出。

改提示词后请回归：中文直问、英文越权、英文自我介绍、套提示词、角色扮演绕过、自我介绍，六条都不该出现厂商或模型名。

## 配额与计费

Campbell 按上游真实 token 用量计费，Scooby 免费。计费量以「gpt-6-astra 的输入 token」
为 1 单位，权重写在 `backend/models.json` 的 `billing` 字段，与上游价目表成正比：

| 模型 | 输入 | 缓存命中输入 | 输出 |
| ---- | ---- | ------------ | ---- |
| gpt-6-astra | 1 | 0.1 | 5 |
| gpt-image-2.5-flare / sunburst | 0.5 | — | 3 |

`credits = 计费量 / CREDIT_TOKEN_SCALE`，默认 5000，普通一问一答约 1 credit。出图按同一公式算，
不足 `IMAGE_MIN_CREDITS`（默认 2）的按下限计。失败不扣。日额 100、月额 1000。

数据库存的是原始计费量而非算好的 credits，调整权重后历史数据可以整体重算。
历史数据回填见 [backend/scripts/backfill_usage_units.py](backend/scripts/backfill_usage_units.py)，
先不带参数试算，确认后加 `--apply`。

## 快速开始

### 端口规范

开发用整数端口，生产末位补 3。前端调后端默认走 `http://localhost:5000`，
改端口时用 `lockai/.env.local` 里的 `NEXT_PUBLIC_API_URL` 覆盖。

| 环境 | 前端 | 后端 |
| ---- | ---- | ---- |
| 开发 | 3000 | 5000 |
| 生产 | 3003 | 5003 |

后端端口由 `backend/.env` 的 `PORT` 决定；生产走 gunicorn，端口见
[backend/gunicorn.conf.py](backend/gunicorn.conf.py)。两个前端端口都已在
[backend/app.py](backend/app.py) 的 CORS 白名单里。

### 后端

```bash
cd backend
conda create -n lockai python=3.11
conda activate lockai
pip install -r requirements.txt
cp .env.example .env   # 配置 API 密钥
python app.py          # http://localhost:5000，接口文档 http://localhost:5000/docs
```

`.env` 里 `DEV_RELOAD=true` 时改代码自动重启（旧变量名 `FLASK_DEBUG` 仍然认）。

跑测试直接 `python -m pytest -q`。`tests/test_api_contract.py` 覆盖前端调用的每一条路由，
改路由或换框架后它必须原样通过。

### 前端

```bash
cd lockai
npm install
npm run dev            # http://localhost:3000
```

## 部署

根目录 `deploy.py` 打包前后端为 `dist/lockai-backend.zip` 与 `dist/lockai-frontend.zip`。Gunicorn 配置见 [backend/gunicorn.conf.py](backend/gunicorn.conf.py)。

后端启动命令：

```bash
pip install -r requirements.txt
gunicorn -c gunicorn.conf.py asgi:app
```

从 Flask 版本升级时，旧命令 `gunicorn -c gunicorn.conf.py wsgi:app` 仍可用，`wsgi.py` 只是转发到 `asgi.py`。
**不要**再给后端打 gevent 补丁，它和 FastAPI 的事件循环冲突。

## License

Private — Funk&Love Internal Use Only
