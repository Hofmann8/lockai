# Word 文档（DOCX）

成篇的论文、报告先看 writing.md：用 `todocx` 从 Markdown / LaTeX 转，样式现成、质量最好。这里是其他 Word 场景。

## 选工具
- **成篇文字**：写 Markdown，`todocx report.md -o /home/user/outputs/x.docx`（套 `/opt/lockai/templates/reference.docx`：宋体小四、1.5 倍行距、黑体标题、三线表、页码）。别用 python-docx 一段段手搓。
- **版式特殊的短文档**（通知、证书、表单）：python-docx。标题用内置样式 `Heading 1/2/3`（导航窗格和目录才认），正文用 `Normal`。
- **按模板批量生成**（通知、证书、邀请函、合同）：docxtpl。在模板里写 `{{ name }}`、`{% for %}`，`tpl = DocxTemplate(path); tpl.render(ctx); tpl.save(out)`（`render` 不返回对象，别链式调用）；一人一份就循环里每次重新 `DocxTemplate(path)`。
- **改用户的已有文档**：python-docx 打开原文件，只改要改的段落 / 表格，保留原样式；不要重建整份文档。
- **读 Word 内容**：`mammoth` 转成 HTML / 纯文本最干净；表格用 python-docx 遍历 `doc.tables`。
- 用户给了 Word 模板要照着排：`todocx report.md --reference-doc 模板.docx`，样式交给模板。

## 中文排版
- 中文字体写 Windows 上的名字（宋体 / 黑体 / 楷体 / 仿宋），用户打开才不会被替换；沙箱预览会自动映射到思源字体。要同时设东亚字体，否则会回退成怪字体：
  ```python
  from docx.oxml.ns import qn
  style = doc.styles['Normal']; style.font.name = 'Times New Roman'
  style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
  ```
- 公文 / 正式文件：正文小四（12pt）、1.5 倍行距、首行缩进 2 字符（`paragraph_format.first_line_indent = Pt(24)`）。
- 表格：设 `table.style = 'Table Grid'`，表头加粗、浅灰底；数字右对齐。
- 页边距默认 2.54 / 3.17 cm，一般不用改。

## 自检（必须做）
```bash
soffice --headless --convert-to pdf --outdir /tmp/check /home/user/outputs/x.docx >/dev/null 2>&1
pdftoppm -png -r 50 -f 1 -l 3 /tmp/check/x.pdf /tmp/check/p
```
`show` 看前几页：中文是否正常、标题层级是否清楚、表格是否撑破页面、有没有空白页。

## 交付
写到 `/home/user/outputs/`，文件名用中文也可以（如 `活动通知.docx`）。批量生成的多个文件打成一个 zip 再交付。
