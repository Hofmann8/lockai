# Excel 表格（XLSX）

## 选工具
- **读 / 清洗 / 分析**：pandas（`pd.read_excel(path, sheet_name=None)` 一次读所有工作表）。先 `df.head()`、`df.dtypes`、`df.isna().sum()` 看清数据再动手。
- 查询复杂时用 DuckDB 写 SQL：先 `df = pd.read_excel(...)`，再 `duckdb.sql("select ... from df")`（DuckDB 读 xlsx 要联网装扩展，别用 `read_xlsx`）；CSV 直接 `read_csv('a.csv')`。
- **生成给人看的表**：openpyxl（要改已有文件、保留格式）或 xlsxwriter（新建、格式和图表更方便）。

## 做表原则
- **能用公式就用公式**，别把算好的数写死：合计 `=SUM(B2:B20)`、占比 `=B2/B$21`。用户以后改原始数据，结果会跟着变。
- **公式要带上算好的值**：xlsxwriter / openpyxl 都不会计算公式，文件里只有公式没有结果，网页预览、手机预览、pandas 读出来都是 0 或空。xlsxwriter 用 `ws.write_formula('B21', '=SUM(B2:B20)', fmt, total)` 把 Python 里算好的值作为最后一个参数带上；openpyxl 写的公式没法带值，写完用 LibreOffice 重算一遍再交付：`soffice --headless --convert-to xlsx --outdir /tmp/recalc x.xlsx`，把 `/tmp/recalc/x.xlsx` 拷到 outputs（沙箱里的 LibreOffice 打开时会重算公式；表里有 xlsxwriter 图表的别这样做，改用 write_formula 带值）。
- 表头冻结、加筛选，两个库的写法不一样，别混用：
  - xlsxwriter：`ws.freeze_panes(1, 0)`、`ws.autofilter(0, 0, last_row, last_col)`
  - openpyxl：`ws.freeze_panes = 'A2'`、`ws.auto_filter.ref = ws.dimensions`
- 列宽按内容设（中文一个字约 2 个宽度单位）；数字千分位、百分比、日期都设单元格格式，不要存成文本。
- 一张表一个主题；原始数据和汇总分成不同工作表。
- 条件格式标出异常值比手工涂色好。
- 图表：xlsxwriter 的 `workbook.add_chart({'type': 'column'})`，数据引用工作表里的区域，不要贴图片。

## 清洗常见坑
- 合并单元格读出来是 NaN：`ffill()` 补上。
- 数字被存成文本（带空格、全角数字、"1,234"）：先清洗再 `pd.to_numeric`。
- 日期列格式混杂：`pd.to_datetime(..., errors='coerce')`，然后检查变成 NaT 的行。
- 中文表头有空格 / 换行：`df.columns = df.columns.str.strip()`。

## 自检
重新用 pandas 读一遍成品，打印关键汇总数，确认公式区域和数值对得上；需要看版式时转 PDF 截图用 `show` 看。

## 交付
写到 `/home/user/outputs/`。回复里用一两句说明表里有哪些工作表、关键结论是什么。
