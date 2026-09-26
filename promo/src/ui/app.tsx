import type { CSSProperties, ReactNode } from 'react';
import { ChatHeader, Sidebar, type SessionRow } from './kit';

/** 片子里的"屏幕"：产品的桌面布局（侧栏 272 + 对话栏 + 可选的文件面板），固定 1600×960 */
export const APP_W = 1600;
export const APP_H = 960;
export const SIDEBAR_W = 272;
export const COL_MAX = 736;

export const BASE_SESSIONS: SessionRow[] = [
  { title: '招新文案润色' },
  { title: '周四排练曲目' },
];
export const OLDER_SESSIONS: SessionRow[] = [
  { title: 'Battle 规则整理' },
  { title: '音响租赁比价' },
  { title: '社团账目核对' },
];
export const WEEK_SESSIONS: SessionRow[] = [
  { title: '新生基本功训练计划' },
  { title: '服装采购清单' },
  { title: '秋季招新复盘' },
];

export function AppFrame({
  frame, title, busy, newSession, children, panel, panelW = 0, dark, style, panelContentW = 760,
}: {
  frame: number; title?: string; busy?: boolean; newSession?: SessionRow | null; children: ReactNode;
  panel?: ReactNode; panelW?: number; dark?: boolean; style?: CSSProperties; panelContentW?: number;
}) {
  const today = newSession ? [newSession, ...BASE_SESSIONS] : BASE_SESSIONS;
  return (
    <div
      className={dark ? 'dark' : 'light'}
      style={{
        width: APP_W, height: APP_H, borderRadius: 18, overflow: 'hidden', display: 'flex',
        background: 'var(--bg)', color: 'var(--fg)', fontFamily: 'var(--font-sans)',
        boxShadow: '0 0 0 1px oklch(0.3 0.01 60 / 0.08), 0 30px 80px -24px oklch(0.25 0.02 50 / 0.35), 0 80px 160px -60px oklch(0.25 0.02 50 / 0.3)',
        ...style,
      }}
    >
      <Sidebar
        frame={frame}
        busy={busy}
        groups={[
          { label: '今天', rows: today },
          { label: '昨天', rows: OLDER_SESSIONS },
          { label: '七天内', rows: WEEK_SESSIONS },
        ]}
      />
      <div className="relative flex h-full min-w-0 flex-1 flex-col">
        <ChatHeader title={title} showActions={!!title} />
        <div className="relative min-h-0 flex-1">{children}</div>
      </div>
      {panelW > 0 && (
        <aside className="relative h-full shrink-0 overflow-hidden border-l border-line bg-bg" style={{ width: panelW }}>
          <div className="h-full" style={{ width: panelContentW }}>{panel}</div>
        </aside>
      )}
    </div>
  );
}
