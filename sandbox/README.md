# 云沙箱模板

LockAI 的 `shell` 工具跑在阿里云函数计算云沙箱（E2B 协议兼容，杭州）。后端在北京，跨地域只多几十毫秒。每个会话一台沙箱，
空闲 5 分钟自动回收（空闲也计费，而恢复只要一两秒）；每轮用过沙箱后工作区（`work/`、`outputs/`）打包存到 OSS
`workspaces/<会话 id>.tar.gz`，下次新建沙箱时恢复，所以用户隔天回来文件还在。

| 目录 | 用途 |
|---|---|
| `/home/user/inputs` | 用户上传的附件（文件夹保留目录结构）和图片（`images/`），按需从 OSS 并发拉进来 |
| `/home/user/work` | 模型的工作目录 |
| `/home/user/outputs` | 放进来的文件每条命令后自动交付给用户（前端显示成文件卡片） |
| `/opt/lockai/skills` | 场景经验说明书，见 [skills/README.md](skills/README.md) |
| `/opt/lockai/templates` | 论文 LaTeX 模板 `paper.tex`、Word 样式母版 `reference.docx`、幻灯片模板 `slides/`（`base.css` + 示例 `deck.html`） |

## 文档和幻灯片怎么出

用户在设置里选「排版质量优先」（默认）或「方便编辑优先」，后端把对应的交付偏好拼进系统提示（`backend/services/tool_contracts.py` 的 `DELIVERY_PREFERENCES`）。

| | 质量优先 | 编辑优先 |
|---|---|---|
| 长文档 | LaTeX（`paper.tex`）→ xelatex 出 PDF；`todocx 论文.tex` 从源文件转一份 Word | Markdown → `todocx` 出 Word → LibreOffice 转 PDF |
| 幻灯片 | HTML（`slides/base.css`，每页 1280×720）→ `slides2pdf` 出 PDF；要 PPT 文件加 `--pptx` 出图片版 | pptxgenjs 出可编辑 PPTX → LibreOffice 转 PDF |

`bin/` 里的命令行工具（装在 `/usr/local/bin`）：

- `todocx`：pandoc + `reference.docx` 转 Word，再用 python-docx 修细节（三线表、题注编号、参考文献、标题间距），中文排版照国内论文习惯（宋体小四、1.5 倍行距、首行缩进两字）
- `slides2pdf`：Chromium 打印 PDF；先注入脚本检查每页是否溢出，没有 `<section class="slide">` 的空文件直接拒绝导出；`--png` 出小图自检
- `apply_patch`：Codex 补丁格式改文件（GPT 系模型的习惯用法），任何一块对不上就整个不落盘
- `typst`：Python 绑定包一层，只支持 `compile`

`fontconfig/64-lockai-office.conf` 把 Word 里常见的宋体 / 黑体 / Times New Roman / Arial / Calibri 映射到镜像里的 Noto CJK、TeX Gyre、Carlito，LibreOffice 转出来的预览和用户电脑上打开基本一致；公式要 `libreoffice-math-nogui` 才能渲染。`libreoffice/registrymodifications.xcu` 让 LibreOffice 打开表格时总是重算公式（xlsxwriter / openpyxl 写的公式不带结果）。

## 改环境 → 发布

1. 改 `Dockerfile` / `skills/`
2. 拉大文件：`python sandbox/fetch_models.py`（抠图模型 176MB，存在 OSS 私有目录 `assets/models/`，不进 git）
3. 本地构建并自检（`verify.sh` 以沙箱用户身份做 30 项真实转换，全部 OK 再发布；Windows 的 Git Bash 里 `docker run` 前面加 `MSYS_NO_PATHCONV=1`，不然挂载路径会被改写）

   ```bash
   cd sandbox
   docker build --platform linux/amd64 --provenance=false --sbom=false -t lockai-sandbox:dev .
   docker run --rm --platform linux/amd64 --user user -v "$PWD/verify.sh:/tmp/verify.sh:ro" --entrypoint bash lockai-sandbox:dev /tmp/verify.sh
   ```

4. 推到 ACR 个人版（杭州，公开仓库，沙箱拉镜像不用凭证）

   ```bash
   REPO=crpi-erg46jo9l599ryzm.cn-hangzhou.personal.cr.aliyuncs.com/lock-service/lockai-sandbox
   TAG=$(date +%Y%m%d)
   docker tag lockai-sandbox:dev $REPO:$TAG
   docker push $REPO:$TAG
   ```

5. 登记成模板（模板名一次性，自动叫 `lockai-office-<tag>`），再把 `backend/.env` 的 `SANDBOX_TEMPLATE` 改成新名字、重启后端；已经在跑的沙箱不受影响

   ```bash
   python sandbox/build_template.py $REPO:$TAG
   ```

## 注意

- e2b SDK 固定 `2.50.0`：2.51 起创建沙箱走 `POST /v2/sandboxes`，阿里云返回 405
- 阿里云不支持 E2B 的分步构建，环境改动只能写进镜像
- 阿里云的模板**一个名字只能构建一次**（再建报 409），所以版本号写进模板名
- 登记模板时函数计算会把镜像转换后以 `<tag>-fce2b-<build id 前缀>` 存回同一个仓库，当前模板用的这一对（原始 + 转换）都别删；换版本后把上一版的一对在 ACR 控制台删掉
- **镜像仓库必须和沙箱同一地域**（跨地域登记模板报 `Image and function must be in the same region`）：杭州的 ACR 个人版只能给杭州的沙箱用
- 底包 Node 20 已停止维护，镜像里覆盖装了 Node 22；覆盖前必须删掉旧的 npm 目录，否则 npm 会坏
- Word / PPT 交付时后端会在沙箱里用 LibreOffice 另转一份 PDF（`<文件>.preview.pdf`）给网页预览；表格和用户上传的 Word 在浏览器里解析，不经过第三方
- 端口预览地址 `https://<端口>-<沙箱 id>.cn-hangzhou.e2b.fc.aliyuncs.com` 不带鉴权，拿到链接就能访问
- 沙箱里访问 pypi.org 慢、Hugging Face 不通：pip 默认走阿里云镜像，`HF_ENDPOINT` 指向 hf-mirror
