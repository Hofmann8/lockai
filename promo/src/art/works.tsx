import type { CSSProperties, ReactNode } from 'react';
import QRCode from 'qrcode';

/*
 * 片子里 LockAI "做出来"的作品：Funk&Love 冬季 Jam 的一整套物料。
 * 同一套视觉系统（暖纸色、炭黑、琥珀 / 锈橙的 70 年代同心弧、Fraunces 软衬线），
 * 这样作品之间的连续转场才说得通。
 */

export const INK = 'oklch(0.22 0.012 55)';
export const PAPER = 'oklch(0.955 0.018 82)';
export const AMBER = 'oklch(0.72 0.16 58)';
export const RUST = 'oklch(0.58 0.17 38)';
export const OCHRE = 'oklch(0.82 0.13 85)';
export const DEEP = 'oklch(0.36 0.09 35)';

const display = (soft = 100, wonk = 1): CSSProperties => ({
  fontFamily: 'var(--font-fraunces)',
  fontVariationSettings: `"SOFT" ${soft}, "WONK" ${wonk}, "opsz" 144`,
});

/** 70 年代同心弧（日落 / 唱片），海报、PPT、网页共用 */
export function Arcs({ size, colors = [RUST, AMBER, OCHRE, PAPER], rings = 4, style }: {
  size: number; colors?: string[]; rings?: number; style?: CSSProperties;
}) {
  return (
    <div style={{ position: 'absolute', width: size, height: size / 2, overflow: 'hidden', ...style }}>
      {Array.from({ length: rings }).map((_, i) => {
        const d = size * (1 - i / rings);
        return (
          <div
            key={i}
            style={{
              position: 'absolute', left: (size - d) / 2, top: (size - d) / 2, width: d, height: d, borderRadius: '50%',
              background: colors[i % colors.length],
            }}
          />
        );
      })}
    </div>
  );
}

/** 两道竖线：品牌母题，作品里只做很淡的呼应 */
export function PairLines({ h, gap = 9, color = INK, style }: { h: number; gap?: number; color?: string; style?: CSSProperties }) {
  return (
    <div style={{ position: 'absolute', display: 'flex', gap, ...style }}>
      <span style={{ width: 3, height: h, background: color, borderRadius: 2 }} />
      <span style={{ width: 3, height: h, background: AMBER, borderRadius: 2 }} />
    </div>
  );
}

export function Qr({ text = 'https://lockai.funkandlove.cn/jam', size, color = INK, bg = 'transparent' }: { text?: string; size: number; color?: string; bg?: string }) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  const rects: ReactNode[] = [];
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (qr.modules.get(x, y)) rects.push(<rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell + 0.3} height={cell + 0.3} />);
    }
  }
  return (
    <svg width={size} height={size} style={{ background: bg, display: 'block' }}>
      <g fill={color}>{rects}</g>
    </svg>
  );
}

/* ---------------- 海报 ---------------- */

export const POSTER_W = 1131;
export const POSTER_H = 1600;

export type PosterLayer = 'paper' | 'arcs' | 'band' | 'meta' | 'title' | 'tag';
export const POSTER_LAYERS: PosterLayer[] = ['paper', 'arcs', 'band', 'meta', 'title', 'tag'];

/** only：只画某一层（其余透明），用来把海报拆成前后错开的几层 */
export function Poster({ style, only }: { style?: CSSProperties; only?: PosterLayer }) {
  const show = (l: PosterLayer) => !only || only === l;
  return (
    <div style={{ position: 'relative', width: POSTER_W, height: POSTER_H, background: show('paper') ? PAPER : 'transparent', overflow: 'hidden', color: INK, ...style }}>
      {show('paper') && (
        /* 纸面的细微明暗 */
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse 80% 60% at 30% 20%, oklch(1 0.01 85 / 0.7), transparent 70%)' }} />
      )}
      {show('arcs') && <Arcs size={1500} rings={6} colors={[DEEP, RUST, AMBER, OCHRE, 'oklch(0.9 0.07 85)', PAPER]} style={{ left: -185, top: 1045 }} />}
      {show('band') && <div style={{ position: 'absolute', left: 0, right: 0, top: 1430, bottom: 0, background: INK }} />}
      {show('meta') && (
        <>
          <PairLines h={250} style={{ left: 86, top: 96 }} />
          <div style={{ position: 'absolute', left: 130, top: 92, fontFamily: 'var(--font-geist-sans)', fontSize: 26, letterSpacing: '0.32em', fontWeight: 600 }}>
            FUNK&amp;LOVE
          </div>
          <div style={{ position: 'absolute', left: 130, top: 134, fontFamily: 'var(--font-serif-sc)', fontSize: 26, letterSpacing: '0.3em', color: 'oklch(0.45 0.02 55)' }}>
            浙江大学街舞社 · 冬季 Jam
          </div>
          <div style={{ position: 'absolute', right: 86, top: 88, textAlign: 'right', fontFamily: 'var(--font-geist-sans)', fontWeight: 600 }}>
            <div style={{ fontSize: 88, lineHeight: 1, letterSpacing: '-0.03em' }}>12.20</div>
            <div style={{ fontSize: 24, letterSpacing: '0.3em', marginTop: 10, color: RUST }}>SAT · 19:00</div>
          </div>
        </>
      )}
      {show('title') && (
        <div style={{ position: 'absolute', left: 70, top: 330, lineHeight: 0.82, ...display() }}>
          <div style={{ fontSize: 300, fontStyle: 'italic', letterSpacing: '-0.04em' }}>Winter</div>
          <div style={{ fontSize: 470, letterSpacing: '-0.05em', marginLeft: 150, marginTop: -20 }}>Jam</div>
        </div>
      )}
      {show('tag') && (
        <div style={{ position: 'absolute', left: 130, top: 975, fontFamily: 'var(--font-serif-sc)', fontSize: 38, letterSpacing: '0.3em', fontWeight: 600 }}>
          一起，把冬天跳热。
        </div>
      )}
      {show('band') && (
        <div
          style={{
            position: 'absolute', left: 86, bottom: 34, right: 86, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            color: PAPER, fontFamily: 'var(--font-geist-sans)',
          }}
        >
          <div>
            <div style={{ fontSize: 22, letterSpacing: '0.3em', opacity: 0.8 }}>BATTLE · SHOWCASE · OPEN CYPHER</div>
            <div style={{ fontFamily: 'var(--font-serif-sc)', fontSize: 34, marginTop: 14, letterSpacing: '0.12em' }}>紫金港风雨操场 二楼</div>
          </div>
          <div style={{ background: PAPER, padding: 10, borderRadius: 10 }}>
            <Qr size={104} />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 演示稿 ---------------- */

export const SLIDE_W = 1600;
export const SLIDE_H = 900;

function SlideFrame({ children, dark, n }: { children: ReactNode; dark?: boolean; n: number }) {
  return (
    <div
      style={{
        position: 'relative', width: SLIDE_W, height: SLIDE_H, overflow: 'hidden',
        background: dark ? INK : PAPER, color: dark ? PAPER : INK, fontFamily: 'var(--font-geist-sans)',
      }}
    >
      {children}
      <div style={{ position: 'absolute', left: 80, bottom: 48, fontSize: 18, letterSpacing: '0.28em', opacity: 0.55 }}>FUNK&amp;LOVE · WINTER JAM</div>
      <div style={{ position: 'absolute', right: 80, bottom: 48, fontSize: 18, opacity: 0.55, fontVariantNumeric: 'tabular-nums' }}>{String(n).padStart(2, '0')}</div>
    </div>
  );
}

export const BUDGET = [
  { item: '场地与安保', qty: '1 场', price: 3200, owner: '外联部' },
  { item: '音响与 DJ', qty: '4 小时', price: 2800, owner: '技术部' },
  { item: '灯光与舞台', qty: '1 套', price: 2150, owner: '技术部' },
  { item: '比赛奖品', qty: '6 份', price: 1680, owner: '赛事组' },
  { item: '物料印刷', qty: '300 份', price: 1140, owner: '宣传部' },
  { item: '摄影摄像', qty: '2 机位', price: 960, owner: '宣传部' },
  { item: '饮用水与补给', qty: '240 人', price: 550, owner: '后勤部' },
];
export const BUDGET_TOTAL = BUDGET.reduce((a, b) => a + b.price, 0);
export const yuan = (n: number) => `¥${n.toLocaleString('en-US')}`;

export function SlideCover() {
  return (
    <SlideFrame dark n={1}>
      <Arcs size={1400} rings={5} colors={[RUST, AMBER, OCHRE, 'oklch(0.9 0.07 85)', INK]} style={{ left: 520, top: 420 }} />
      <PairLines h={160} color={PAPER} style={{ left: 80, top: 96 }} />
      <div style={{ position: 'absolute', left: 124, top: 92, fontSize: 22, letterSpacing: '0.3em' }}>招新宣讲 · 2026 冬</div>
      <div style={{ position: 'absolute', left: 74, top: 180, lineHeight: 0.86, ...display() }}>
        <div style={{ fontSize: 200, fontStyle: 'italic', letterSpacing: '-0.04em' }}>Winter</div>
        <div style={{ fontSize: 260, letterSpacing: '-0.05em', marginLeft: 90 }}>Jam</div>
      </div>
      <div style={{ position: 'absolute', left: 80, top: 690, fontFamily: 'var(--font-serif-sc)', fontSize: 34, letterSpacing: '0.2em' }}>
        12 月 20 日 · 紫金港风雨操场
      </div>
    </SlideFrame>
  );
}

export function SlideBudget({ grow = 1, bars, total = BUDGET_TOTAL }: { grow?: number; bars?: number[]; total?: number }) {
  const max = Math.max(...BUDGET.map((b) => b.price));
  return (
    <SlideFrame n={3}>
      <div style={{ position: 'absolute', left: 80, top: 80, fontSize: 20, letterSpacing: '0.3em', color: RUST }}>BUDGET</div>
      <div style={{ position: 'absolute', left: 80, top: 116, fontFamily: 'var(--font-serif-sc)', fontSize: 64, fontWeight: 600 }}>预算一览</div>
      <div style={{ position: 'absolute', right: 80, top: 96, textAlign: 'right' }}>
        <div style={{ fontSize: 20, opacity: 0.6 }}>总预算</div>
        <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{yuan(Math.round(total))}</div>
      </div>
      <div style={{ position: 'absolute', left: 80, right: 80, top: 270 }}>
        {BUDGET.map((b, i) => {
          const g = bars ? bars[i] ?? 0 : Math.max(0, Math.min(1, grow * 1.6 - i * 0.09));
          return (
            <div key={b.item} style={{ display: 'flex', alignItems: 'center', height: 76, gap: 28 }}>
              <div style={{ width: 230, fontFamily: 'var(--font-serif-sc)', fontSize: 28 }}>{b.item}</div>
              <div style={{ flex: 1, height: 34, position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, background: 'oklch(0.9 0.02 80)', borderRadius: 4 }} />
                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(b.price / max) * 100 * g}%`, background: i === 0 ? RUST : i < 3 ? AMBER : OCHRE, borderRadius: 4 }} />
              </div>
              <div style={{ width: 150, textAlign: 'right', fontSize: 28, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{yuan(b.price)}</div>
            </div>
          );
        })}
      </div>
    </SlideFrame>
  );
}

export function SlideWhy() {
  const stats = [['240', '预计到场'], ['16', 'Battle 选手'], ['4', '支 Showcase 队伍']];
  return (
    <SlideFrame n={2}>
      <div style={{ position: 'absolute', left: 80, top: 80, fontSize: 20, letterSpacing: '0.3em', color: RUST }}>WHY JAM</div>
      <div style={{ position: 'absolute', left: 80, top: 150, fontFamily: 'var(--font-serif-sc)', fontSize: 84, fontWeight: 600, lineHeight: 1.3 }}>
        一个晚上，<br />所有人一起跳。
      </div>
      <div style={{ position: 'absolute', left: 80, right: 80, top: 560, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 40 }}>
        {stats.map(([n, l], i) => (
          <div key={l} style={{ borderTop: `3px solid ${i === 0 ? RUST : INK}`, paddingTop: 22 }}>
            <div style={{ fontSize: 96, fontWeight: 600, letterSpacing: '-0.04em', fontVariantNumeric: 'tabular-nums', ...display(50, 0) }}>{n}</div>
            <div style={{ fontFamily: 'var(--font-serif-sc)', fontSize: 28, opacity: 0.65, marginTop: 4 }}>{l}</div>
          </div>
        ))}
      </div>
    </SlideFrame>
  );
}

export function SlideFlow() {
  const steps = [
    ['19:00', '签到入场', '领手环与号码牌'],
    ['19:30', 'Showcase', '四支队伍开场表演'],
    ['20:15', 'Battle', '1v1 · 16 进 1'],
    ['21:40', 'Open Cypher', '所有人一起'],
  ];
  return (
    <SlideFrame n={4}>
      <div style={{ position: 'absolute', left: 80, top: 80, fontSize: 20, letterSpacing: '0.3em', color: RUST }}>RUNDOWN</div>
      <div style={{ position: 'absolute', left: 80, top: 116, fontFamily: 'var(--font-serif-sc)', fontSize: 64, fontWeight: 600 }}>当晚流程</div>
      <div style={{ position: 'absolute', left: 80, right: 80, top: 360, height: 2, background: INK, opacity: 0.2 }} />
      <div style={{ position: 'absolute', left: 80, right: 80, top: 330, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 40 }}>
        {steps.map(([t, a, b], i) => (
          <div key={t}>
            <div style={{ width: 60, height: 60, borderRadius: '50%', background: i === 2 ? RUST : AMBER, marginBottom: 40 }} />
            <div style={{ fontSize: 46, fontWeight: 600, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{t}</div>
            <div style={{ fontSize: 34, marginTop: 10, ...display(50, 0) }}>{a}</div>
            <div style={{ fontFamily: 'var(--font-serif-sc)', fontSize: 24, marginTop: 10, opacity: 0.6 }}>{b}</div>
          </div>
        ))}
      </div>
    </SlideFrame>
  );
}

/* ---------------- 手机报名页 ---------------- */

export function Landing({ filled = 0, pressed = 0, count = 186, done = 0 }: { filled?: number; pressed?: number; count?: number; done?: number }) {
  // 报名人填的是花名
  const name = '霍夫曼'.slice(0, Math.round(Math.min(1, filled / 0.4) * 3));
  return (
    <div style={{ width: 390, height: 760, background: PAPER, color: INK, position: 'relative', overflow: 'hidden', fontFamily: 'var(--font-geist-sans)' }}>
      <div style={{ position: 'relative', height: 290, background: INK, color: PAPER, overflow: 'hidden' }}>
        <Arcs size={560} rings={5} colors={[RUST, AMBER, OCHRE, 'oklch(0.9 0.07 85)', INK]} style={{ left: -85, top: 160 }} />
        <div style={{ position: 'absolute', left: 24, top: 54, fontSize: 12, letterSpacing: '0.3em' }}>FUNK&amp;LOVE</div>
        <div style={{ position: 'absolute', left: 20, top: 80, lineHeight: 0.85, ...display() }}>
          <div style={{ fontSize: 76, fontStyle: 'italic', letterSpacing: '-0.04em' }}>Winter</div>
          <div style={{ fontSize: 104, letterSpacing: '-0.05em', marginLeft: 40 }}>Jam</div>
        </div>
        <div style={{ position: 'absolute', right: 20, top: 50, fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }}>12.20</div>
      </div>
      <div style={{ padding: '18px 22px 0' }}>
        <div style={{ fontFamily: 'var(--font-serif-sc)', fontSize: 22, fontWeight: 600 }}>报名参加冬季 Jam</div>
        <div style={{ fontSize: 13, opacity: 0.6, marginTop: 6 }}>12 月 20 日 19:00 · 紫金港风雨操场二楼</div>
        {[
          ['姓名', name],
          ['学院', filled > 0.6 ? '计算机科学与技术学院' : ''],
        ].map(([k, v]) => (
          <div key={k} style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 6 }}>{k}</div>
            <div style={{ height: 44, borderRadius: 12, border: '1px solid oklch(0.85 0.01 70)', background: 'oklch(0.985 0.005 85)', display: 'flex', alignItems: 'center', padding: '0 14px', fontSize: 15 }}>{v}</div>
          </div>
        ))}
        <div style={{ marginTop: 16, fontSize: 12, opacity: 0.55, marginBottom: 8 }}>想参加</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {['Battle', 'Showcase', 'Open Cypher', '只是来看'].map((c, i) => (
            <span key={c} style={{ padding: '7px 13px', borderRadius: 999, fontSize: 13, border: `1px solid ${i === 0 && filled > 0.8 ? INK : 'oklch(0.85 0.01 70)'}`, background: i === 0 && filled > 0.8 ? INK : 'transparent', color: i === 0 && filled > 0.8 ? PAPER : INK }}>{c}</span>
          ))}
        </div>
        <div
          style={{
            marginTop: 18, height: 48, borderRadius: 14, background: RUST, color: PAPER, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: 600, letterSpacing: '0.1em', transform: `scale(${1 - 0.04 * pressed})`,
          }}
        >
          {done > 0.5 ? '报名成功 ✓' : '立即报名'}
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, opacity: 0.5, marginTop: 12, fontVariantNumeric: 'tabular-nums' }}>已有 {count} 人报名 · 剩余 {240 - count} 个名额</div>
      </div>
    </div>
  );
}

/* ---------------- 执行手册（Word） ---------------- */

export function HandbookPage() {
  return (
    <div style={{ width: 794, height: 1123, background: 'white', color: INK, padding: '84px 90px', fontFamily: 'var(--font-serif-sc)', position: 'relative' }}>
      <div style={{ fontFamily: 'var(--font-geist-sans)', fontSize: 12, letterSpacing: '0.3em', color: RUST }}>FUNK&amp;LOVE · WINTER JAM</div>
      <div style={{ fontSize: 34, fontWeight: 700, marginTop: 14 }}>冬季 Jam 执行手册</div>
      <div style={{ fontSize: 14, color: 'oklch(0.5 0.01 60)', marginTop: 8 }}>版本 1.0 · 12 月 20 日 · 紫金港风雨操场二楼</div>
      <div style={{ height: 1, background: 'oklch(0.88 0.01 70)', margin: '26px 0' }} />
      {[
        ['一、活动概览', '本次 Jam 面向全校开放，预计到场 240 人。流程分为签到、Showcase、1v1 Battle 与 Open Cypher 四段，全程约三个半小时。'],
        ['二、分工与联系人', '外联部负责场地与安保对接；技术部负责音响、DJ 与灯光；赛事组负责 Battle 抽签、计分与奖品；宣传部负责物料与影像记录。'],
        ['三、时间节点', '12 月 6 日前确认场地与设备；12 月 13 日开放报名并发布海报；12 月 18 日完成彩排；12 月 20 日 17:30 全员到场布置。'],
      ].map(([h, p]) => (
        <div key={h} style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{h}</div>
          <div style={{ fontSize: 14.5, lineHeight: 1.9, color: 'oklch(0.32 0.01 60)' }}>{p}</div>
        </div>
      ))}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, marginTop: 6 }}>
        <thead>
          <tr>{['时间', '环节', '负责人'].map((h) => <th key={h} style={{ textAlign: 'left', padding: '8px 10px', background: 'oklch(0.96 0.01 80)', borderBottom: '1px solid oklch(0.88 0.01 70)' }}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {[['19:00', '签到入场', '后勤部'], ['19:30', 'Showcase', '赛事组'], ['20:15', 'Battle', '赛事组'], ['21:40', 'Open Cypher', '全体']].map((r) => (
            <tr key={r[0]}>{r.map((c) => <td key={c} style={{ padding: '8px 10px', borderBottom: '1px solid oklch(0.92 0.005 70)' }}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
