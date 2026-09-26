# 排期、日程与日历

## 日期计算
- 今天的日期看系统提示词里的"当前时间"，不要用沙箱的 `date`（沙箱时区是 UTC）。需要时 `TZ=Asia/Shanghai date`。
- Python：`datetime` + `dateutil.relativedelta`（加几个月、每月最后一个周五）。

## 中国节假日与调休
- `chinesecalendar`：
  ```python
  import chinese_calendar as cc
  cc.is_workday(d); cc.is_holiday(d)
  cc.get_holiday_detail(d)          # (是否节假日, 节日名)
  cc.get_workdays(start, end)       # 区间内的工作日（已算上调休补班）
  ```
  它只收录已公布的年份；更远的年份如实说明"放假安排未公布"。
- **农历 / 节气**：`lunar-python`：
  ```python
  from lunar_python import Solar, Lunar
  Solar.fromYmd(2026, 9, 25).getLunar().toString()     # 公历转农历
  Lunar.fromYmd(2026, 8, 15).getSolar().toYmd()        # 农历八月十五是哪天
  ```

## 排期表
- 排练 / 活动排期：先列约束（可用时间段、场地、每人冲突、截止日），再排；排不下时列出冲突让用户取舍，不要悄悄违反约束。
- 输出成 Excel（按 xlsx.md 的规范：冻结表头、日期格式、按周分组）或一张清晰的图（matplotlib 画甘特图 / 周视图）。

## 导出到手机日历（.ics）
```python
from icalendar import Calendar, Event
from datetime import datetime
from zoneinfo import ZoneInfo
tz = ZoneInfo('Asia/Shanghai')
cal = Calendar(); cal.add('prodid', '-//LockAI//'); cal.add('version', '2.0')
ev = Event()
ev.add('summary', '周三排练'); ev.add('location', '紫金港风雨操场')
ev.add('dtstart', datetime(2026, 10, 8, 19, 0, tzinfo=tz)); ev.add('dtend', datetime(2026, 10, 8, 21, 0, tzinfo=tz))
ev.add('rrule', {'freq': 'weekly', 'count': 8})      # 每周重复 8 次；不重复就去掉
ev.add('uid', 'rehearsal-20261008@lockai')
cal.add_component(ev)
open('/home/user/outputs/排练日程.ics', 'wb').write(cal.to_ical())
```
告诉用户：手机上点开 .ics 文件即可导入系统日历；可以加提醒（`VALARM`）。
