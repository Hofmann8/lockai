# 演示文稿（PPTX，可编辑）

交付偏好是「质量优先」时做幻灯片看 slides.md（HTML 排版导出 PDF，效果好得多）。这里用于：偏好是「可编辑优先」、用户明确要能改字的 PPT、或者要改用户给的 .pptx。

## 选工具
- **默认用 pptxgenjs（Node）**：版式控制最细，写一个 `build.js` 用 `node build.js` 生成。全局已装，`require('pptxgenjs')` 直接可用。
- 要改用户给的已有 .pptx：用 python-pptx 打开原文件改，保留原模板和母版。
- 用户只要"快速出一份、内容为主"：Marp（Markdown → PPTX/PDF）最快：`marp slides.md --pptx -o /home/user/outputs/x.pptx --allow-local-files`。

## 先想清楚再写代码
1. 先列大纲：每页一个核心观点，标题写结论（"报名人数同比翻倍"）而不是话题（"报名情况"）。
2. 页数：没说就 8–12 页。封面、目录（5 页以上才要）、内容页、总结 / 致谢。
3. 统一设计：一套配色（1 个主色 + 1 个强调色 + 灰阶）、一种标题字号、一种正文字号，全篇不变。

## 版式经验（16:9，`const pres = new (require('pptxgenjs'))(); pres.layout = 'LAYOUT_WIDE'`，13.33 × 7.5 英寸）
- 文档属性：`pres.title = '演示标题'`（不设的话预览和 PDF 标题栏显示 "PptxGenJS Presentation"），`pres.author` 可留空。
- 字体：`fontFace: 'Microsoft YaHei'`（用户电脑上有，能直接改字；沙箱预览会自动映射到思源黑体）。标题 28–36pt，正文 16–20pt，注释 12pt；正文少于 16pt 投影看不清。
- 每页正文不超过 6 行、每行不超过 20 个汉字；字多就拆页或改成图表 / 对比卡片。
- 四周留白 ≥ 0.5 英寸；元素左对齐到同一条线上。
- 数据页用原生图表 `slide.addChart(...)`，不要贴截图；图表配色跟主题一致。
- 图片：外层 `w` / `h` 填图片原始宽高比（先用 PIL 取尺寸按比例换算），`sizing` 里填目标框：`slide.addImage({ path, x, y, w: 原比例宽, h: 原比例高, sizing: { type: 'cover', w: 框宽, h: 框高 } })`；两组填一样的会把图拉变形。
- 深色封面 + 浅色内容页是稳妥组合。

## 自检（必须做）
```bash
cd /home/user/work && soffice --headless --convert-to pdf --outdir /tmp/check /home/user/outputs/x.pptx >/dev/null 2>&1
pdftoppm -png -r 50 /tmp/check/x.pdf /tmp/check/p   # 生成 p-01.png, p-02.png …
```
用 `show` 看几页（封面、最密的一页、图表页）。常见问题：文字溢出文本框、中文变方块（字体名写错）、元素重叠、图片变形。改完再看一次。

## 交付
成品写到 `/home/user/outputs/<有意义的名字>.pptx`；用户要 PDF 版就一起导出放在 outputs。
