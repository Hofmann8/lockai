# 数据分析与图表

## 流程
1. 读数据后先看结构：行列数、字段类型、缺失、异常值。有疑问的口径（比如"人数"按人还是按人次）在回复里说明你的假设。
2. 算数用 pandas / DuckDB，结论要有数字支撑；复杂统计用 statsmodels / scipy。
3. 出图，再用 `show` 看图是否清楚。
4. 回复里给结论和关键数字，不要把整张表贴出来。

## matplotlib（默认）
- 中文字体已设为默认（Noto Sans CJK SC），直接写中文标题即可；负号正常显示。
- 模板：
  ```python
  import matplotlib.pyplot as plt
  plt.rcParams.update({'figure.dpi': 150, 'axes.spines.top': False, 'axes.spines.right': False})
  fig, ax = plt.subplots(figsize=(8, 4.5))
  ...
  ax.set_title('标题写结论，例如：九月报名人数创新高', loc='left', fontsize=13)
  fig.tight_layout(); fig.savefig('/home/user/outputs/chart.png', dpi=200)
  ```
- 选图：比较用柱状图（类别多就横向）、趋势用折线、占比少于 5 类才用饼图（否则用条形）、分布用直方图 / 箱线图、相关用散点。
- 配色克制：一个主色 + 灰色，只高亮要强调的那一组。数值标签比网格线更有用。
- 不要 3D、不要双 Y 轴（除非用户要）。

## 交互式图表
- plotly：`fig.write_html('/home/user/outputs/chart.html', include_plotlyjs='cdn')`；要静态图用 `fig.write_image('x.png', scale=2)`（kaleido 已装，走本机 Chromium）。
- pyecharts（国内常用的 ECharts 风格）：`chart.render('/home/user/outputs/chart.html')`。

## 其他
- 词云：wordcloud + jieba 分词，`font_path` 用 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`。
- 网络关系图：networkx 计算，matplotlib 或 plotly 画。
- 流程图 / 结构图：graphviz（`dot -Tpng`）或 mermaid（`mmdc -i a.mmd -o a.png -p /opt/lockai/puppeteer.json`，文件不存在就去掉 -p）。
