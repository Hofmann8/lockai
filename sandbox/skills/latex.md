# LaTeX / Typst 排版

论文、报告的完整流程先看 writing.md；这里是排版细节和排错。

## 选哪个
- **LaTeX（xelatex + ctex）**：论文、报告、讲义、公式多的文档，默认用它。模板 `/opt/lockai/templates/paper.tex`，能用 `todocx` 转成 Word。
- **Typst**：简历、海报、单页讲义这类版式自由、不需要 Word 版的东西，写起来更快：
  `typst compile main.typ /home/user/outputs/main.pdf`；中文 `#set text(font: ("TeX Gyre Termes", "Noto Serif CJK SC"), lang: "zh")`，标题用 `Noto Sans CJK SC`。
- 用户给了 .tex 模板（学校 / 期刊）：在它的基础上改，不要换成自己的模板。

## 编译
```bash
latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex > build.log 2>&1 || grep -n -A3 '^!' main.log | head -30
```
- 报错看 main.log 里第一个 `!` 开头的行，不要只看最后几行。
- 交叉引用、目录 latexmk 会自动多跑几遍；清理中间文件 `latexmk -c`。
- 缺宏包别联网装，换等价的（已装 ctex、amsmath、geometry、booktabs、tikz、siunitx、hyperref、caption 等）。

## 字体（镜像里有的）
- 中文：`Noto Serif CJK SC`（宋体风格）、`Noto Sans CJK SC`（黑体风格）。模板里已经设好，`\sffamily` 就是黑体。
- 西文：`TeX Gyre Termes`（Times 风格）、`TeX Gyre Heros`（Arial 风格）、Latin Modern。
- 字号用 ctex 的 `\zihao{-4}`（小四）、`\zihao{4}`（四号）等。

## 版式经验
- 表格用 booktabs 三线表（`\toprule \midrule \bottomrule`），不要竖线；表题在上、图题在下。
- 公式 `equation` 环境自动编号，引用 `\eqref{}`。
- 长表 `longtable`，宽表 `\resizebox{\linewidth}{!}{...}`（Word 版不受影响）。
- 目录：`\tableofcontents` 放在摘要后；Word 版不带目录，用户在 Word 里一键插入。
- 页眉页脚、封面页这类只对 PDF 有意义的东西尽量少做，Word 版不会有。

## 简历（Typst）
单页、信息密度高：两栏或左侧窄栏；姓名 20–24pt、正文 10–10.5pt、行距 1.3；经历按时间倒序，每条用动词开头、带量化结果。出图自检：`mkdir -p /tmp/check && rm -f /tmp/check/*.png && typst compile main.typ /tmp/check/p{p}.png --ppi 60`。

## 自检
`mkdir -p /tmp/check && rm -f /tmp/check/*.png && pdftoppm -png -r 60 -f 1 -l 2 main.pdf /tmp/check/p` 然后 `show`：中文是否出现、公式是否正确、有无溢出边界（`grep -c 'Overfull' main.log` 很多时要检查）。
