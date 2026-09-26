# 网页 / 小工具 / 前端项目

## 先判断规模
- **单页小东西**（落地页、计算器、小游戏、可视化、邀请函）：一个自包含的 `index.html`（CSS / JS 写在里面，第三方库用 CDN：`https://cdn.jsdelivr.net/npm/...` 或 `https://registry.npmmirror.com/...` 下的包）。最快、最好分享。
- **有多个页面 / 组件 / 构建**：Vite 项目。
  ```bash
  cd /home/user/work && npm create vite@latest app -- --template react-ts   # 或 vue-ts / vanilla-ts
  cd app && npm install
  ```
  npm 已配国内镜像；装依赖把 `timeout` 设到 300。

## 预览
- 开发中给用户看：`shell` 用 `background: true` + `port`：
  - 单文件：`cd /home/user/work/site && python3 -m http.server 8000`，port 8000
  - Vite：先在 `vite.config` 里加 `server: { host: true, allowedHosts: true }`（新版 Vite 会拦截预览域名，报 Blocked request），再 `cd /home/user/work/app && npx vite --port 5173`，port 5173
  工具结果里会返回公网预览地址，告诉用户可以打开看；这个地址在沙箱回收后失效。
- **交付成品**：
  - 单文件：把 `index.html` 复制到 `/home/user/outputs/`。
  - Vite：`npm run build` 后把 `dist/` 打成 zip 放到 outputs；若是纯静态、只有一个页面，也可以用 `vite-plugin-singlefile` 之类的方式做成单个 html 交付。

## 设计经验
- 移动端优先：`<meta name="viewport" content="width=device-width, initial-scale=1">`，布局用 flex / grid，宽度自适应。
- 字体栈：`font-family: system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;`
- 克制的配色和充足的留白比花哨效果更显高级；动画用 CSS transition，时长 150–300ms。
- 交互元素要有 hover / active 状态，按钮点击区域不小于 40px。

## 自检
用 Chromium 截图用 `show` 看：
```bash
chromium --headless --no-sandbox --window-size=1280,800 --screenshot=/tmp/desktop.png http://localhost:8000
chromium --headless --no-sandbox --window-size=390,844 --screenshot=/tmp/mobile.png http://localhost:8000
```
检查排版、中文显示、移动端有没有横向滚动条；有 JS 的顺便看控制台报错（`--enable-logging=stderr --v=0`）。
