# 技能说明书

每个场景一份 Markdown，打进沙箱模板的 `/opt/lockai/skills/`。系统提示词里只列名称和一句话用途
（清单在 `backend/services/tool_contracts.py` 的 `SANDBOX_SKILLS`，增删文件要同步改那里），
模型需要时自己 `cat /opt/lockai/skills/<名称>.md` 读完整内容再动手。

写法：写经验而不是流程——用什么工具、常见坑、成品怎么自检（转成图片用 `show` 看一遍）。

配套的模板在 `sandbox/templates/`（打进 `/opt/lockai/templates/`），命令行工具在 `sandbox/bin/`（`todocx`、`slides2pdf`、`typst`）。

| 文件 | 场景 |
|---|---|
| writing.md | 论文、报告等长文档（查证 → 写作 → LaTeX 或 Word） |
| slides.md | 演示文稿，质量优先：HTML 排版导出 PDF |
| pptx.md | 演示文稿，可编辑：pptxgenjs / 改已有 PPT |
| docx.md | Word 文档、按模板批量生成、改已有 Word |
| xlsx.md | Excel 表格、清洗数据 |
| pdf.md | 生成 / 处理 PDF |
| latex.md | LaTeX / Typst 排版细节、简历 |
| charts.md | 数据分析与出图 |
| media.md | 音视频处理、节拍分析 |
| images.md | 图片处理、抠图、二维码、OCR |
| web.md | 网页与前端项目、预览 |
| schedule.md | 排期、农历、调休、.ics 日历 |
