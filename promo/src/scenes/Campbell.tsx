import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { FileText } from 'lucide-react';
import { Camera, Grain, Plane, Vignette, lerp } from '../lib/stage';
import { bf, easeIn, easeInOut, easeLock, easeOut, prog } from '../lib/time';
import { hits, pick } from '../lib/hits';

/** 字母落在 56–58 拍贝斯和吉他的切分上 */
const LETTER_AT = pick(hits(['bass', 'other', 'vocals'], 56, 58), 8, 56, 58, 4);
/** 计划的五行各卡一个音头 */
const ROW_AT = pick(hits(['bass', 'other', 'vocals'], 66.5, 69.5), 5, 66.5, 69.5, 8);
/** 70 拍那串四连十六分音符：四行任务一行一个派出去 */
const SEND_AT = pick(hits(['other', 'bass'], 70, 71), 4, 70, 71, 4);

/*
 * Campbell 亮相（31.8 – 39.8s）
 * 两道竖线从左往右扫过，换到暗场。字标一个字母一个字母落定；三个短句各落在一个重音上；
 * 然后是它写下的 PLAN.md：哪块自己做、哪块交给 Scooby。
 */

export const CAMPBELL_START = bf(56) - 12;
export const CAMPBELL_WIPE = bf(56) - 10;
export const CAMPBELL_END = bf(72) + 16;

const PLAN = [
  { n: '01', text: '主视觉海报 · A2 印刷版 + 手机竖版', who: 'Scooby 2.0' },
  { n: '02', text: '预算表与报名数据 · Excel', who: 'Scooby 2.0' },
  { n: '03', text: '宣讲 PPT · 引用 01、02 的结果', who: 'Scooby 2.0' },
  { n: '04', text: '报名网页 + 二维码', who: 'Scooby 2.0' },
  { n: '05', text: '验收 · 逐个截图检查，统一配色与文案', who: 'Campbell' },
];

/** 两道竖线扫场：返回遮罩位置（0–1）和两条线 */
export function PairWipe({ frame, start, len = 20, dir = 1, lineColor = 'oklch(0.97 0.01 80)' }: {
  frame: number; start: number; len?: number; dir?: 1 | -1; lineColor?: string;
}) {
  const p = prog(frame, start, start + len, easeInOut);
  if (p <= 0 || p >= 1) return null;
  const x = dir > 0 ? p * 1920 : 1920 - p * 1920;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: x - 16 * dir, width: 3, background: lineColor, boxShadow: `0 0 24px ${lineColor}` }} />
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: x, width: 3, background: 'var(--accent)', boxShadow: '0 0 30px var(--accent)' }} />
    </AbsoluteFill>
  );
}
export const wipeClip = (frame: number, start: number, len = 20, dir: 1 | -1 = 1) => {
  const p = prog(frame, start, start + len, easeInOut);
  return dir > 0 ? `inset(0 ${(1 - p) * 100}% 0 0)` : `inset(0 0 0 ${(1 - p) * 100}%)`;
};

export function Campbell() {
  const local = useCurrentFrame();
  const g = local + CAMPBELL_START;
  const wipeStart = CAMPBELL_WIPE;

  // 字标：逐字母落定
  const letters = 'Campbell'.split('');
  const lift = prog(g, bf(66) - 6, bf(67), easeInOut);

  const phrases = [
    { t: '理解目标。', at: bf(60) },
    { t: '组织工作。', at: bf(62) },
    { t: '检查结果。', at: bf(64) },
  ];

  // 慢推的镜头 + 计划卡片从下方升起
  const cam = { x: 0, y: lerp(0, 150, lift), z: lerp(2200, 2050, prog(g, bf(56), bf(72), easeInOut)), rx: lerp(0, 4, lift), ry: lerp(-2, 3, prog(g, bf(56), bf(72), easeInOut)), persp: 2400 };
  const planIn = prog(g, bf(66) - 4, bf(67) + 6, easeOut);
  const dispatch = prog(g, SEND_AT[0], bf(72) + 4, easeInOut);

  return (
    <AbsoluteFill style={{ clipPath: wipeClip(g, wipeStart) }}>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 80% 70% at 50% 40%, oklch(0.21 0.006 60), oklch(0.13 0.005 60) 70%, oklch(0.09 0.004 60))' }} />
      {/* 地平线上的一道琥珀色余光 */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 60% 30% at 50% 108%, oklch(0.745 0.138 56 / 0.18), transparent 70%)' }} />
      <Camera cam={cam}>
        <Plane w={1600} h={400} y={-60} opacity={1 - 0.0 * lift}>
          <div className="dark" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', transform: `translateY(${-lift * 120}px) scale(${1 - lift * 0.42})` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 28 }}>
              <div style={{ fontFamily: 'var(--font-fraunces)', fontSize: 196, fontStyle: 'italic', lineHeight: 1, letterSpacing: '-0.03em', color: 'oklch(0.95 0.008 80)', fontVariationSettings: '"SOFT" 100, "WONK" 1, "opsz" 144' }}>
                {letters.map((ch, i) => {
                  const p = prog(g, LETTER_AT[i], LETTER_AT[i] + 14, easeLock);
                  return (
                    <span key={i} style={{ display: 'inline-block', opacity: Math.min(1, p * 1.6), transform: `translateY(${(1 - p) * 40}px)`, filter: `blur(${(1 - Math.min(1, p)) * 8}px)` }}>{ch}</span>
                  );
                })}
              </div>
              <div
                style={{
                  fontFamily: 'var(--font-geist-sans)', fontWeight: 300, fontSize: 84, color: 'var(--accent)', letterSpacing: '-0.02em',
                  opacity: prog(g, bf(58), bf(58) + 14, easeOut), transform: `translateX(${(1 - prog(g, bf(58), bf(58) + 18, easeLock)) * -20}px)`,
                }}
              >
                3.0
              </div>
            </div>
            <div style={{ display: 'flex', gap: 56, marginTop: 44 }}>
              {phrases.map((ph, i) => {
                const p = prog(g, ph.at, ph.at + 16, easeLock);
                const active = g >= ph.at && (i === phrases.length - 1 || g < phrases[i + 1].at);
                return (
                  <div key={ph.t} style={{ position: 'relative', fontFamily: 'var(--font-serif-sc)', fontSize: 44, letterSpacing: '0.18em', color: 'oklch(0.93 0.008 80)', opacity: p * (active || g >= bf(66) ? 1 : 0.55), transform: `translateY(${(1 - p) * 16}px)`, filter: `blur(${(1 - p) * 6}px)` }}>
                    <span style={{ position: 'absolute', left: -20, top: '50%', display: 'flex', gap: 3, transform: `translateY(-50%) scaleY(${active ? prog(g, ph.at, ph.at + 10, easeLock) : 0})` }}>
                      <span style={{ width: 2.5, height: 26, borderRadius: 2, background: 'oklch(0.75 0.01 80)' }} />
                      <span style={{ width: 2.5, height: 26, borderRadius: 2, background: 'var(--accent)' }} />
                    </span>
                    {ph.t}
                  </div>
                );
              })}
            </div>
          </div>
        </Plane>

        {/* PLAN.md */}
        {planIn > 0 && (
          <Plane w={980} h={350} y={lerp(430, 220, planIn)} z={lerp(-200, 0, planIn)} rx={lerp(18, 6, planIn)} scale={1.38} opacity={planIn} res={2}>
            <div className="dark" style={{ width: '100%', height: '100%', fontFamily: 'var(--font-sans)' }}>
              <div className="rounded-2xl border border-line bg-surface" style={{ height: '100%', boxShadow: '0 40px 90px -30px oklch(0 0 0 / 0.7)' }}>
                <div className="flex h-12 items-center gap-2 border-b border-line px-5 text-[13px] text-fg-soft">
                  <FileText className="h-4 w-4" />
                  <span className="font-mono">PLAN.md</span>
                  <span className="ml-auto text-[12px] text-fg-faint">Campbell 写 · 所有执行助手先读它</span>
                </div>
                <div className="px-5 py-3">
                  {PLAN.map((row, i) => {
                    const p = prog(g, ROW_AT[i], ROW_AT[i] + 12, easeLock);
                    const send = i < 4 ? prog(g, SEND_AT[i], SEND_AT[i] + 12, easeLock) : 0;
                    return (
                      <div
                        key={row.n}
                        className="flex items-center gap-4 border-b border-line py-3.5 last:border-b-0"
                        style={{ opacity: p, transform: `translateX(${(1 - p) * -16 + send * 60}px)` }}
                      >
                        <span className="font-mono text-[13px] tabular-nums text-fg-faint">{row.n}</span>
                        <span className="flex-1 text-[17px] text-fg">{row.text}</span>
                        <span
                          className="rounded-md px-2 py-0.5 text-[12px]"
                          style={{
                            background: row.who === 'Campbell' ? 'var(--accent-soft)' : 'var(--surface-2)',
                            color: row.who === 'Campbell' ? 'var(--accent)' : 'var(--fg-soft)',
                            boxShadow: send > 0 ? `0 0 ${send * 18}px var(--accent)` : undefined,
                          }}
                        >
                          {row.who === 'Campbell' ? 'Campbell 自己' : '→ ' + row.who}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Plane>
        )}
      </Camera>
      <Vignette strength={0.5} />
      <Grain opacity={0.08} />
      {/* 派出去：四道光从计划里射向右边，接下一个镜头 */}
      {/* 每一行在自己的那个十六分音符上射出去，从该行的标签那里起飞 */}
      {dispatch > 0 && (
        <AbsoluteFill>
          {[0, 1, 2, 3].map((i) => {
            const d = prog(g, SEND_AT[i], SEND_AT[i] + 22, easeIn);
            if (d <= 0 || d >= 1) return null;
            return (
              <div
                key={i}
                style={{
                  position: 'absolute', left: 1560 + d * 520, top: [478, 564, 651, 737][i], width: 300, height: 2,
                  background: 'linear-gradient(90deg, transparent, var(--accent))', opacity: 1 - d * 0.6, filter: 'blur(0.5px)',
                }}
              />
            );
          })}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
}

