# 演示文稿（质量优先）：HTML 排版 → PDF

交付偏好是「质量优先」时做幻灯片用这条路线：用网页排版，版式、字体、配色都能精确控制，导出的 PDF 在任何电脑上放映都一样。
偏好是「可编辑优先」、用户明确要能改的 PPT、或要改用户给的 .pptx 时，看 pptx.md。

## 开工
```bash
mkdir -p /home/user/work/deck && cp /opt/lockai/templates/slides/* /home/user/work/deck/ && cd /home/user/work/deck
# deck.html 是示例：封面、要点页、大数字、章节页、左右分栏 + 条形图、时间线、引用、结尾。照着改，别从零写 CSS
slides2pdf deck.html -o "/home/user/outputs/标题.pdf" --png /tmp/check
```
`slides2pdf` 会先检查每页有没有内容溢出（输出"注意: 第 N 页内容超出了页面"），再导出 PDF；`--png` 出每页小图给 `show` 自检。

## 先想清楚再写
1. 大纲：每页一个核心观点，标题写结论（"报名人数同比翻倍"）而不是话题（"报名情况"）。
2. 页数：没说就 8–12 页。封面 →（5 页以上才要目录）→ 内容 → 总结 / 结尾。
3. 统一：一个主色（`--accent`）+ 灰阶，全篇不换字号体系。按主题挑配色：`<body class="theme-blue">`（商务、科技）、`theme-green`（环保、健康、教育）、`theme-ink`（深色、发布会）、默认暖白（人文、通用）；或者只改 `:root { --accent: …; --accent-soft: …; }`。

## 版式（base.css 里现成的类）
- 每页：`<section class="slide">` → `.kicker`（小标签，可选）→ `<h2>` 标题 → `<div class="body">` 内容（在剩余空间里垂直居中；要贴着标题排加 `.top`）→ `<div class="foot">` 页脚（可选）。页码自动。
- 封面 `.slide.cover`、章节页 `.slide.section`、结尾 `.slide.end`、整页大图 `.slide.full-image`（`<img>` + `.overlay`）。
- 内容组件：`ul.points` 要点、`ol.steps` 步骤、`.cols`（`.three` / `.wide-left` / `.wide-right` / `.middle`）分栏、`.card`（`.accent`）卡片、`.stat` 大数字、`.quote` 引用、`.timeline` 时间线、`table.data` 表格、`.bars` 条形图、`figure` 图片、`.tag` 标签。
- 字号不要改小：正文 22px、卡片 19px 已经是投影能看清的下限。字多就拆页，不要缩字。
- 每页正文不超过 6 行；一页只放一个图表或一组卡片。

## 图表和图片
- 数据图用 matplotlib / pyecharts 出 PNG 或 SVG（透明背景、配色用同一个主色、中文字体已配好），`<figure class="contain"><img src="chart.png"></figure>` 放进去。
- 简单对比直接用 `.bars` / `.stat`，比插图清爽。
- 图片放在 deck 目录里用相对路径；网络图片先下载到本地。

## 必须交 PPT 文件时
PDF 已经能直接放映。用户明确要 .pptx 但偏好是质量优先：`slides2pdf deck.html -o 标题.pdf --pptx "/home/user/outputs/标题.pptx"` 另出一份图片版（外观和 PDF 一样、字不能改），并在回复里说明；要能改字就按 pptx.md 重做。

## 自检
`show` 看封面、最密的一页、图表页：有没有溢出、重叠、空白过多、字太小。有"内容超出"的提示一定要改。

## 交付
PDF 写到 `/home/user/outputs/<标题>.pdf`；HTML 源文件留在 work，不放进 outputs。
