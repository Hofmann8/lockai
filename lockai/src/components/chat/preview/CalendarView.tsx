'use client';

import { useMemo } from 'react';
import { Bell, CalendarPlus, MapPin, Repeat } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { Dot, downloadFile, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';
import { CodeView } from './CodeView';

interface CalEvent {
  summary: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: string;
  alarms: number;
}

/** 展开折行、按 BEGIN/END 取出事件 */
function parseIcs(text: string): { name?: string; events: CalEvent[] } {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events: CalEvent[] = [];
  let name: string | undefined;
  let current: Record<string, { value: string; params: string }> | null = null;
  let alarms = 0;
  let inAlarm = false;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { current = {}; alarms = 0; continue; }
    if (line === 'BEGIN:VALARM') { inAlarm = true; alarms += 1; continue; }
    if (line === 'END:VALARM') { inAlarm = false; continue; }
    if (line === 'END:VEVENT' && current) {
      const start = parseDate(current.DTSTART);
      const end = parseDate(current.DTEND);
      events.push({
        summary: unescape(current.SUMMARY?.value ?? '（无标题）'),
        start: start.date,
        end: end.date,
        allDay: start.allDay,
        location: current.LOCATION && unescape(current.LOCATION.value),
        description: current.DESCRIPTION && unescape(current.DESCRIPTION.value),
        rrule: current.RRULE?.value,
        alarms,
      });
      current = null;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [key, ...params] = line.slice(0, idx).split(';');
    const value = line.slice(idx + 1);
    if (!current && key === 'X-WR-CALNAME') name = unescape(value);
    if (current && !inAlarm) current[key.toUpperCase()] = { value, params: params.join(';') };
  }
  return { name, events };
}

function unescape(v: string) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseDate(prop?: { value: string; params: string }): { date: Date | null; allDay: boolean } {
  if (!prop) return { date: null, allDay: false };
  const m = prop.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return { date: null, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { date: new Date(+y, +mo - 1, +d), allDay: true };
  // 带 TZID 的按当地时间显示（日程基本都是本地时间）；Z 结尾的是 UTC
  const date = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { date, allDay: false };
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const FREQ: Record<string, string> = { DAILY: '每天', WEEKLY: '每周', MONTHLY: '每月', YEARLY: '每年' };

function repeatLabel(rrule: string) {
  const parts = Object.fromEntries(rrule.split(';').map((p) => p.split('=')));
  const interval = Number(parts.INTERVAL ?? 1);
  let label = FREQ[parts.FREQ] ?? '重复';
  if (interval > 1) label = `每 ${interval} ${({ DAILY: '天', WEEKLY: '周', MONTHLY: '个月', YEARLY: '年' } as Record<string, string>)[parts.FREQ] ?? '次'}`;
  if (parts.COUNT) label += ` · 共 ${parts.COUNT} 次`;
  if (parts.UNTIL) label += ` · 到 ${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`;
  return label;
}

const time = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** 日历文件：按天排好的日程（像日历 App 的列表视图），可以一键导入 */
export default function CalendarView({ file }: { file: FileArtifact }) {
  const { text, error } = useFetched(file.url, 'text');
  const parsed = useMemo(() => (text === undefined ? null : parseIcs(text)), [text]);

  if (error) return <PreviewFallback file={file} note="日历文件没能加载出来，可以下载后导入日历" />;
  if (!parsed || text === undefined) return <Opening />;
  if (parsed.events.length === 0) return <CodeView code={text} language="text" label="日历（没有读到事件）" />;

  const sorted = [...parsed.events].sort((a, b) => (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
  const days: Array<{ date: Date | null; events: CalEvent[] }> = [];
  for (const ev of sorted) {
    const last = days[days.length - 1];
    if (last && ((last.date && ev.start && dayKey(last.date) === dayKey(ev.start)) || (!last.date && !ev.start))) last.events.push(ev);
    else days.push({ date: ev.start, events: [ev] });
  }
  const today = dayKey(new Date());

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <button
            type="button"
            onClick={() => file.url && void downloadFile(file.url, file.name.split('/').pop()!)}
            className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-fg-soft transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <CalendarPlus className="h-3.5 w-3.5" /> 导入日历
          </button>
        }
      >
        <span className="font-medium text-fg-soft">{parsed.name ?? '日历'}</span>
        <Dot />
        <span className="tabular-nums">{parsed.events.length} 个日程</span>
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
        <div className="mx-auto max-w-2xl px-5 py-4">
          {days.map((day, i) => (
            <section key={i} className="flex gap-4 border-b border-line py-4 last:border-0">
              <div className="w-14 shrink-0 text-center">
                {day.date ? (
                  <>
                    <p className={cn('text-[11.5px]', dayKey(day.date) === today ? 'text-accent' : 'text-fg-faint')}>{WEEK[day.date.getDay()]}</p>
                    <p className={cn('text-[26px] font-semibold leading-tight tabular-nums', dayKey(day.date) === today ? 'text-accent' : 'text-fg')}>{day.date.getDate()}</p>
                    <p className="text-[11px] tabular-nums text-fg-faint">{day.date.getFullYear()}.{day.date.getMonth() + 1}</p>
                  </>
                ) : (
                  <p className="text-[12px] text-fg-faint">未定</p>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                {day.events.map((ev, j) => (
                  <div key={j} className="relative rounded-xl bg-surface-2/60 py-2 pl-4 pr-3">
                    <span className="absolute inset-y-2 left-1.5 w-[3px] rounded-full bg-accent/70" aria-hidden />
                    <p className="text-[13.5px] font-medium leading-snug text-fg">{ev.summary}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-fg-soft">
                      <span className="tabular-nums">
                        {ev.allDay ? '全天' : ev.start ? `${time(ev.start)}${ev.end ? ` – ${time(ev.end)}` : ''}` : ''}
                      </span>
                      {ev.location && <span className="flex min-w-0 items-center gap-1"><MapPin className="h-3 w-3 shrink-0" /><span className="truncate">{ev.location}</span></span>}
                      {ev.rrule && <span className="flex items-center gap-1"><Repeat className="h-3 w-3" />{repeatLabel(ev.rrule)}</span>}
                      {ev.alarms > 0 && <span className="flex items-center gap-1"><Bell className="h-3 w-3" />提醒</span>}
                    </p>
                    {ev.description && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[12px] leading-relaxed text-fg-faint">{ev.description}</p>}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
