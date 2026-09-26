# LockAI 云沙箱模板：日常轻量办公 / 媒体 / 数据 / 排版 / 网页的开箱环境
#
# 基于阿里云函数计算官方代码解释器镜像（Debian 13, Python 3.13，Node 升级到 22，自带
# pandas / numpy / matplotlib / seaborn / plotly / scikit-learn / opencv / ffmpeg），
# 补上中文字体、Office 文档链、PDF、LaTeX、网页渲染、音视频、OCR 等常用工具。
# 构建与发布见 sandbox/README.md。

FROM fc-e2b-registry.cn-beijing.cr.aliyuncs.com/runtime/code-interpreter-v1:v0.0.44

USER root
ENV DEBIAN_FRONTEND=noninteractive

# 构建期和运行期都走国内镜像
RUN sed -i 's#deb.debian.org#mirrors.aliyun.com#g; s#security.debian.org#mirrors.aliyun.com#g' \
        /etc/apt/sources.list.d/*.sources 2>/dev/null || true

# ---------- 系统工具 ----------
RUN apt-get update && apt-get install -y --no-install-recommends \
        # 字体：没有中文字体时图表 / PDF / PPT 里的中文全是方块
        fontconfig fonts-noto-cjk fonts-noto-color-emoji fonts-wqy-microhei fonts-liberation2 \
        # Office 文档：Word / Excel / PPT 互转、转 PDF（无界面版）
        libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
        # 文档转换与 PDF
        pandoc poppler-utils qpdf ghostscript \
        # LaTeX（中文 + 常用宏包 + beamer 幻灯片）
        texlive-xetex texlive-lang-chinese texlive-latex-extra texlive-fonts-recommended \
        texlive-science latexmk lmodern \
        # 图片与矢量
        imagemagick librsvg2-bin potrace libimage-exiftool-perl \
        # OCR（中英文）
        tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-eng \
        # 音频
        sox libsox-fmt-mp3 rubberband-cli mediainfo \
        # 网页渲染：HTML 转 PDF / 截图、Marp / Mermaid 导出
        chromium \
        # 图表与流程图
        graphviz \
        # WeasyPrint（HTML/CSS 排版成 PDF）需要的库、条码识别
        libpango-1.0-0 libpangoft2-1.0-0 libzbar0 \
        # 常用命令行
        jq sqlite3 p7zip-full zip unzip unar rsync tree bc dos2unix opencc file less nano \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# ImageMagick 默认禁止处理 PDF，放开
RUN for f in /etc/ImageMagick-*/policy.xml; do \
        sed -i 's#rights="none" pattern="PDF"#rights="read|write" pattern="PDF"#' "$f"; done || true

# ---------- Python 包（阿里云 PyPI 镜像） ----------
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
        # Office / PDF
        python-docx docxtpl mammoth python-pptx openpyxl xlsxwriter xlrd \
        pypdf pdfplumber pymupdf reportlab weasyprint pdf2image img2pdf markdown \
        # 排版
        typst \
        # 图片
        pillow-heif cairosvg qrcode python-barcode pyzbar rembg onnxruntime \
        # OCR（中文效果好，模型随包）
        rapidocr-onnxruntime pytesseract \
        # 音视频
        moviepy pydub librosa soundfile yt-dlp \
        # 中文文本
        jieba pypinyin opencc-python-reimplemented wordcloud chardet \
        # 日期与日程：农历、法定节假日调休、日历文件
        lunar-python chinesecalendar icalendar \
        # 数据
        duckdb polars pyarrow statsmodels sympy networkx tabulate csvkit pyecharts kaleido \
        # 网页抓取与解析
        beautifulsoup4 lxml trafilatura feedparser \
        # 杂项
        jinja2 pyyaml faker tqdm

# ---------- Node 全局工具（npmmirror） ----------
# 底包是 Node 20（已停止维护），mermaid / marp 的新版依赖要 22；直接覆盖装到 /usr/local
RUN set -eux; \
    base=https://npmmirror.com/mirrors/node/latest-v22.x; \
    file=$(curl -fsSL "$base/SHASUMS256.txt" | grep -o 'node-v22[0-9.]*-linux-x64\.tar\.gz' | head -1); \
    # 旧版 npm 不清掉会和新版文件混在一起，npm 直接坏掉
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack; \
    curl -fsSL "$base/$file" | tar -xz -C /usr/local --strip-components=1 \
        --exclude='*.md' --exclude=LICENSE --exclude=CHANGELOG.md; \
    node -v; npm -v; \
    # 底包的 pnpm 是 corepack 垫片，缓存在 /root 下，沙箱里的 user 用不了，换成真装
    rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    BROWSER_PATH=/usr/bin/chromium
RUN npm config set registry https://registry.npmmirror.com --location=global \
    && npm install -g --no-fund --no-audit \
        pnpm pptxgenjs docx exceljs pdf-lib \
        @marp-team/marp-cli @mermaid-js/mermaid-cli \
        typescript tsx vite serve prettier katex \
    && npm cache clean --force

# ---------- 运行期默认配置 ----------
# 图表默认中文字体；Hugging Face 走国内镜像；抠图模型放固定目录
RUN mkdir -p /etc/matplotlib /opt/lockai && printf '%s\n' \
        'font.sans-serif: Noto Sans CJK SC, WenQuanYi Micro Hei, DejaVu Sans' \
        'axes.unicode_minus: False' > /etc/matplotlib/matplotlibrc \
    && echo '{"executablePath": "/usr/bin/chromium", "args": ["--no-sandbox"]}' > /opt/lockai/puppeteer.json
ENV MATPLOTLIBRC=/etc/matplotlib \
    HF_ENDPOINT=https://hf-mirror.com \
    U2NET_HOME=/opt/models/u2net \
    NODE_PATH=/usr/local/lib/node_modules \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 抠图模型随镜像带上（176MB，GitHub 在国内下不动；本地先放到 sandbox/models/，见 README）
COPY models/u2net.onnx /opt/models/u2net/models/u2net/u2net.onnx
RUN --network=none chmod -R a+rX /opt/models \
    && python -c "from rembg import new_session; new_session('u2net'); print('rembg model ok')"

# 排版补充（单独一层，前面的大层不用重建）：
# TeX Gyre（Times / Arial 风格，论文西文字体、Word 预览）；Carlito / Caladea 与 Calibri / Cambria 等宽，
# Word 预览不串行；LibreOffice 的 math 负责渲染 Word 里的公式
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-texgyre fonts-crosextra-carlito fonts-crosextra-caladea libreoffice-math-nogui \
    && rm -rf /var/lib/apt/lists/*
# Word / PPT 里常见的 Windows 字体名映射到镜像里的开源字体（LibreOffice 预览、Chromium 渲染用）
COPY fontconfig/64-lockai-office.conf /etc/fonts/conf.d/64-lockai-office.conf
RUN fc-cache -f

# 命令行工具：typst（Python 绑定包一层）、todocx（LaTeX / Markdown → 排好版的 Word）、slides2pdf（HTML 幻灯片 → PDF）、apply_patch（Codex 补丁格式改文件）
COPY --chmod=755 bin/typst bin/todocx bin/slides2pdf bin/apply_patch /usr/local/bin/

# 模板：中文论文 LaTeX、HTML 幻灯片；Word 参考样式在构建时从 pandoc 默认样式生成
COPY templates/ /opt/lockai/templates/
RUN python /opt/lockai/templates/make_reference_docx.py /opt/lockai/templates/reference.docx

# LibreOffice 打开表格时总是重算公式：xlsxwriter / openpyxl 写的公式没有缓存结果，不重算的话转出来的 PDF 里全是 0
COPY --chown=user:user libreoffice/registrymodifications.xcu /home/user/.config/libreoffice/4/user/registrymodifications.xcu

# 技能说明书（场景经验，模型按需读取）
COPY skills/ /opt/lockai/skills/
RUN chmod -R a+rX /opt/lockai

WORKDIR /home/user
