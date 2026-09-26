#!/bin/bash
# 镜像自检：以沙箱里的 user 身份逐项做真实转换，每项一行 OK / FAIL
#   docker run --rm --platform linux/amd64 --user user -v "$PWD/verify.sh:/tmp/verify.sh:ro" --entrypoint bash lockai-sandbox:dev /tmp/verify.sh
cd /tmp && mkdir -p v && cd v
check() { local name="$1"; shift; if out=$(timeout 180 bash -c "$*" 2>&1); then echo "OK   $name ${out:0:80}"; else echo "FAIL $name :: ${out: -300}"; fi; }

check whoami 'whoami; node -v; python --version'
check cjk-fonts '[ $(fc-list :lang=zh | wc -l) -gt 5 ] && fc-list :lang=zh family | head -2 | tr "\n" " "'
check pnpm 'pnpm -v'
check py-imports 'python -c "import pptx, docx, docxtpl, openpyxl, xlsxwriter, fitz, pdfplumber, reportlab, weasyprint, typst, cairosvg, qrcode, pyzbar, rembg, rapidocr_onnxruntime, pytesseract, moviepy, pydub, librosa, yt_dlp, jieba, pypinyin, opencc, wordcloud, lunar_python, chinese_calendar, icalendar, duckdb, polars, statsmodels, pyecharts, kaleido, trafilatura, feedparser, faker; print(\"all\")"'
check docx-to-pdf 'python -c "import docx; d=docx.Document(); d.add_heading(\"测试文档\",0); d.add_paragraph(\"中文段落\"); d.save(\"t.docx\")" && soffice --headless --convert-to pdf t.docx >/dev/null && pdftotext t.pdf - | head -1'
check pptx-js 'node -e "const P=require(\"pptxgenjs\"); const p=new P(); p.addSlide().addText(\"你好\",{x:1,y:1}); p.writeFile({fileName:\"t.pptx\"}).then(()=>console.log(\"ok\"))" && soffice --headless --convert-to pdf t.pptx >/dev/null && pdftoppm -png -r 30 t.pdf slide && ls slide*'
check xelatex 'printf "%s
" "\documentclass{ctexart}" "\begin{document}" "中文 \$E=mc^2\$" "\end{document}" > t.tex && xelatex -interaction=nonstopmode t.tex >/dev/null && pdftotext t.pdf - | head -1'
check typst 'printf "%s
" "#set text(font: \"Noto Serif CJK SC\")" "= 标题" "中文正文" > t.typ && typst compile t.typ && pdftotext t.pdf - | head -1 && typst compile t.typ p.png && ls p-1.png'
check weasyprint 'echo "<meta charset=utf-8><h1>网页转PDF</h1>" > t.html && weasyprint t.html w.pdf && pdftotext w.pdf - | head -1'
check chromium 'chromium --headless --no-sandbox --disable-gpu --screenshot=shot.png --window-size=800,600 file:///tmp/v/t.html >/dev/null 2>&1; ls -la shot.png | cut -c1-60'
check marp 'printf "# 第一页\n---\n# 第二页" > s.md && marp --no-stdin --allow-local-files s.md -o s.pdf >/dev/null 2>&1 && pdfinfo s.pdf | grep Pages'
check mermaid 'printf "graph TD; A[开始]-->B[结束]" > m.mmd && mmdc -p /opt/lockai/puppeteer.json -i m.mmd -o m.png >/dev/null && ls m.png'
check matplotlib-cjk 'python -c "import matplotlib.pyplot as plt, warnings; warnings.simplefilter(\"error\"); plt.title(\"中文标题\"); plt.savefig(\"c.png\"); print(\"no glyph warnings\")"'
check ffmpeg 'ffmpeg -hide_banner -f lavfi -i sine=d=1 -y a.mp3 >/dev/null 2>&1 && python -c "import librosa; y,sr=librosa.load(\"a.mp3\"); print(len(y), sr)"'
check tesseract 'tesseract --list-langs 2>/dev/null | tr "\n" " "'
check rapidocr 'python -c "from PIL import Image,ImageDraw,ImageFont; im=Image.new(\"RGB\",(400,100),\"white\"); f=ImageFont.truetype(\"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc\",40); ImageDraw.Draw(im).text((10,20),\"识别文字\",font=f,fill=\"black\"); im.save(\"o.png\"); from rapidocr_onnxruntime import RapidOCR; r,_=RapidOCR()(\"o.png\"); print(r[0][1] if r else None)"'
check rembg-model 'ls /opt/models/u2net/ && python -c "from rembg import new_session; new_session(\"u2net\"); print(\"loaded\")"'
check imagemagick-pdf 'convert -density 50 t.pdf[0] p.png && ls p.png'
check graphviz 'echo "digraph{a->b}" | dot -Tpng -o g.png && ls g.png'
check chinese-calendar 'python -c "import chinese_calendar as c, datetime; print(c.is_workday(datetime.date(2026,10,1)))"'
check skills 'ls /opt/lockai/skills | tr "\n" " "'
check office-fonts 'for f in 宋体 黑体 "Times New Roman" Arial Calibri; do fc-match "$f" family; done | tr "\n" "/"'
check paper-latex 'mkdir -p paper && cd paper && cp /opt/lockai/templates/paper.tex main.tex && latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex >/dev/null 2>&1 && pdfinfo main.pdf | grep Pages'
check paper-todocx 'cd paper && todocx main.tex -o main.docx >/dev/null && soffice --headless --convert-to pdf --outdir lo main.docx >/dev/null 2>&1 && pdftotext lo/main.pdf - | grep -c -E "摘|参考文献|mc"'
check md-todocx 'printf "%s\n" "---" "title: 标题" "---" "# 一、引言" "正文 \$x^2\$" "" "| a | b |" "|---|---|" "| 1 | 2 |" > r.md && todocx r.md -o r.docx >/dev/null && python -c "import docx; d=docx.Document(\"r.docx\"); print(len(d.tables), \"tables\")"'
check slides2pdf 'mkdir -p deck && cp /opt/lockai/templates/slides/* deck/ && cd deck && slides2pdf deck.html -o deck.pdf --png png --pptx deck.pptx | tr "\n" " "'
check apply-patch 'printf "a\nb\n" > p.txt && printf "*** Begin Patch\n*** Update File: p.txt\n@@\n a\n-b\n+c\n*** End Patch\n" | apply_patch >/dev/null && [ "$(cat p.txt)" = "$(printf "a\nc")" ] && echo patched'
check slides-empty '! (: > empty.html && slides2pdf empty.html -o empty.pdf 2>/dev/null) && [ ! -e empty.pdf ] && echo refused'
check xlsx-recalc 'python -c "import xlsxwriter; wb=xlsxwriter.Workbook(\"f.xlsx\"); ws=wb.add_worksheet(); [ws.write(i,0,v) for i,v in enumerate([3,4,5])]; ws.write_formula(\"A4\",\"=SUM(A1:A3)\"); wb.close()" && soffice --headless --convert-to pdf f.xlsx >/dev/null 2>&1 && pdftotext f.pdf - | grep -qx 12 && echo recalculated'
check pip-user-install 'pip install -q --user tinydb 2>&1 | tail -1; python -c "import tinydb; print(\"pip ok\")"'
