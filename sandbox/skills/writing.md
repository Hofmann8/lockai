# 长文档：论文、报告、策划书、作业

适用：要拿去交、打印或发出去的成篇文字（大约 800 字以上）。短文、邮件、朋友圈文案直接在回答里写，不开沙箱。

## 流程
1. **先查证**：文中要用的事实、数据、政策原文、人物观点、参考文献，先用 `web_search` 查（在沙箱外，一轮可以并发几条）。参考文献只列查到的真实文献（作者、题名、出处、年份都对得上），查不到就不列，绝不编造。
2. **再写**：先定结构（题目、摘要、各级标题、每节要点），再写正文。字数按要求来，没要求就按用途（课程论文 3000 字左右，报告看内容）。
3. **排版**：按系统提示里的「交付偏好」选路线，用户点名要某种格式时以用户为准。
4. **自检**：转成图片 `show` 看首页、最密的一页、参考文献页。
5. **交付**：回复里给题目、结构提纲、查证了哪些内容，不要把全文再贴一遍。

## 路线 A：质量优先（LaTeX → PDF，另转 Word）
版式最好、格式最稳，公式、表格、参考文献都规整。
```bash
mkdir -p /home/user/work/paper && cd /home/user/work/paper
cp /opt/lockai/templates/paper.tex main.tex      # 中文论文模板：思源宋体 / 黑体、小四、1.5 倍行距、三线表
# ……改 main.tex（heredoc 写入）……
latexmk -xelatex -interaction=nonstopmode -halt-on-error main.tex > build.log 2>&1 || grep -n -A3 '^!' main.log | head -30
cp main.pdf "/home/user/outputs/题目.pdf"
todocx main.tex -o "/home/user/outputs/题目.docx"   # 从源文件转 Word，样式同 PDF，可以接着改
```
- 模板里的写法（`\section` / `\subsection`、`\cite` + `thebibliography`、`table` + `booktabs`、`figure` + `\includegraphics`、`equation`、`\footnote`）都能干净转成 Word；别引入模板以外的花哨宏包和自定义命令，Word 版会丢。
- 题目、作者、学校、日期改 `\title` `\author` `\date`；不需要作者信息就删掉 `\author` 里的内容。
- 参考文献按 GB/T 7714—2015 手写在 `thebibliography` 里：`作者. 题名[J]. 刊名, 年, 卷(期): 页码.`、`作者. 书名[M]. 出版地: 出版社, 年.`、网页 `[EB/OL]` 要写访问日期。
- 编译报错、公式、简历等细节看 latex.md。

## 路线 B：可编辑优先（Markdown → Word，附 PDF）
用户要在 Word 里接着改、要套学校模板、或偏好里选了可编辑。
```bash
cd /home/user/work && cat > report.md <<'EOF'
---
title: 题目
author: 作者
date: 2026 年 9 月
abstract: |
  摘要正文……

  **关键词：**关键词一；关键词二
---

# 一、引言
正文……[1]

# 参考文献
[1] 作者. 题名[J]. 刊名, 2024, 12(3): 45-52.
EOF
todocx report.md -o "/home/user/outputs/题目.docx"
soffice --headless --convert-to pdf --outdir /home/user/outputs "/home/user/outputs/题目.docx" >/dev/null 2>&1
```
- 表格用 Markdown 管道表格，会自动变成三线表；图片 `![图 1　标题](chart.png)`。
- 公式 `$...$` / `$$...$$` 会变成 Word 原生公式。
- 用户给了 Word 模板：`todocx report.md --reference-doc 模板.docx`，样式跟着模板走。
- 需要精细控制（批量生成、改用户已有的 Word）看 docx.md。

## 自检
```bash
mkdir -p /tmp/check && rm -f /tmp/check/*.png
pdftoppm -png -r 50 -f 1 -l 2 "/home/user/outputs/题目.pdf" /tmp/check/p
```
`show` 看：标题层级清楚、中文字体正常、没有溢出页边、表格没撑破、参考文献编号和正文引用对得上。
Word 版要单独看时：`soffice --headless --convert-to pdf --outdir /tmp/check "/home/user/outputs/题目.docx"` 再出图（公式应该正常显示；如果是空的，说明转换有问题，要排查）。

## 交付
- 两个文件同名（`题目.pdf` + `题目.docx`），界面会把它们合成一份文档、两种格式。
- 中间文件（.aux、.log、图片源文件）留在 work，不要放进 outputs。
