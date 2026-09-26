# 本机快速启动

两个 PowerShell 窗口，一个后端一个前端。

## 后端（http://localhost:5000）

```powershell
cd D:\日常事务\码农\funkandlove\lockai\backend
conda activate lockai
python app.py
```

- 接口文档：http://localhost:5000/docs
- 改了 `.env` 或后端代码要 Ctrl+C 重启；想改代码自动重启，在 `backend/.env` 加 `DEV_RELOAD=true`
- 本地库是 `backend/instance/lockai.db`，图片走阿里云 OSS `lock-ai` 桶

## 前端（http://localhost:3000）

```powershell
cd D:\日常事务\码农\funkandlove\lockai\lockai
npm run dev
```

- 默认连 `http://localhost:5000`，不用配
- 第一次或者 `package.json` 变了，先 `npm install`

## 跑测试

```powershell
cd D:\日常事务\码农\funkandlove\lockai\backend
conda activate lockai
python -m pytest -q
```

```powershell
cd D:\日常事务\码农\funkandlove\lockai\lockai
npm run lint
```

## 常见问题

| 现象 | 处理 |
|---|---|
| Campbell / 绘图 / 搜索备用通道连不上 | 中转站要走代理，确认本机代理开着 |
| 端口被占用 | 上次没关干净，`netstat -ano \| findstr :5000`（或 `:3000`）找到 PID，`taskkill /PID <PID> /F` |
| 前端页面报接口错误 | 后端没起，或者后端窗口里有报错 |
| 历史图片加载不出来 | 看 `backend/.env` 的 `S3_*` 是不是 OSS 那组 |

生产部署、端口规范、模型与计费说明见 [README.md](README.md)。
