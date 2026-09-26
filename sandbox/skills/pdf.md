# PDF

## 生成好看的 PDF
- **首选：HTML + CSS 排版，再转 PDF**。版式最自由，中文最稳：
  - WeasyPrint：`weasyprint in.html out.pdf`（支持 `@page` 页边距、页眉页脚、分页控制）。HTML 里一定写 `<meta charset="utf-8">`，否则中文变乱码。
  - 需要跑 JS（图表库、复杂布局）时用 Chromium：`chromium --headless --no-sandbox --print-to-pdf=out.pdf --no-pdf-header-footer file:///home/user/work/in.html`。
- CSS 里写 `font-family: 'Noto Sans CJK SC', sans-serif;`。
- 简历、论文、公式多：看 latex.md（Typst / LaTeX）。
- Markdown 转 PDF：`pandoc in.md -o out.html --standalone` 加一段 CSS，再用 WeasyPrint；比 pandoc 直出 LaTeX 省事。

## 处理已有 PDF
- 合并 / 拆分 / 旋转 / 加密解密：`qpdf`（`qpdf --empty --pages a.pdf b.pdf -- out.pdf`）或 pypdf。
- 压缩：`gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -o out.pdf in.pdf`（/screen 更小，/printer 更清晰）。
- 提取文字：`pdftotext -layout in.pdf -`；表格用 pdfplumber `page.extract_tables()`。
- 扫描件（提取不出文字）：先 `pdftoppm -png -r 200` 转图，再按 images.md 里的 OCR 做。
- 转图片：`pdftoppm -png -r 150 in.pdf out/p`；PyMuPDF (`fitz`) 也可以，还能取出内嵌图片。
- 图片合成 PDF：`img2pdf *.jpg -o out.pdf`（不重新压缩，保持清晰）。
- 加水印 / 盖章：PyMuPDF 在每页 `insert_image` 或 `insert_text`；中文文字要指定字体 `page.insert_text(p, '机密', fontname='china-s', fontsize=40)`，默认字体只有西文，中文会变成空白。

## 自检
`pdftoppm -png -r 50 -f 1 -l 3` 截前几页用 `show` 看：中文字形、分页位置（标题别落在页底）、表格是否被截断。

## 交付
写到 `/home/user/outputs/`。
