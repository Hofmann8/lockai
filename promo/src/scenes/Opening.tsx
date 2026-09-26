import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CinematicLock, type LockState } from '../art/CinematicLock';
import { Grain, Vignette, lerp } from '../lib/stage';
import { bf, easeCam, easeIn, easeInOut, easeLock, easeOut, FPS, prog, beat } from '../lib/time';
import { punch } from '../lib/hits';
import { pts } from '../lib/taps';

/** 前奏里那些不在拍上的接拍（手打的点）：左右两道光交替闪 */
const FILLS = pts(13.5, 19.3);
const FILL_L = FILLS.filter((_, i) => i % 2 === 0);
const FILL_R = FILLS.filter((_, i) => i % 2 === 1);
/** 两行字：逐字落在手打的点上（13.6 起那几对接拍）；「重」压在 16.6 JB 那声重喊上 */
const LINE1 = pts(13.5, 14.8);
const LINE2 = pts(15.1, 16.7);

/*
 * 开场（0 – 19.5s，前奏 8 小节）
 * 黑场里先亮起一道琥珀色的线，音乐进来时第二道白线扣上——这是锁孔的两道竖槽。
 * 镜头慢慢退开，光扫过锁身；每个铜管重音锁梁抬一下又停住（犹豫）。最后冲进琥珀色的槽里，白场。
 */

type V3 = [number, number, number];
const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const SLOT: V3 = [0, -0.38, 0.25];
const K0 = { pos: [0.0, -0.38, 2.05] as V3, target: SLOT };
const K1 = { pos: [1.7, 0.35, 4.3] as V3, target: [0.05, -0.1, 0] as V3 };
const K2 = { pos: [-1.15, 0.2, 4.4] as V3, target: [-0.95, -0.12, 0] as V3 };
const K3 = { pos: [0.065, -0.4, 0.34] as V3, target: [0.065, -0.4, 0.2] as V3 };

export function Opening() {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const b0 = beat(0);

  // 镜头
  let pos: V3;
  let target: V3;
  let roll = 0;
  const pull = prog(frame, bf(0), bf(16), easeCam);
  const orbit = prog(frame, bf(16), bf(28), easeInOut);
  const dive = prog(frame, bf(28), bf(32) - 2, (x) => easeIn(x) * 0.35 + 0.65 * x * x * x * x);
  if (frame < bf(16)) {
    pos = mix3(K0.pos, K1.pos, pull);
    target = mix3(K0.target, K1.target, pull);
  } else if (frame < bf(28)) {
    pos = mix3(K1.pos, K2.pos, orbit);
    target = mix3(K1.target, K2.target, orbit);
  } else {
    pos = mix3(K2.pos, K3.pos, dive);
    target = mix3(K2.target, K3.target, dive);
    roll = -0.12 * dive;
  }
  // 开头几秒的极慢漂移，免得画面是死的
  pos = [pos[0] + Math.sin(t * 0.7) * 0.01, pos[1] + Math.sin(t * 0.5) * 0.008, pos[2]];

  // 铜管重音：锁梁抬起、停住、落回犹豫的位置；镜头跟着往前顶一下
  let lift = 0.28;
  let push = 0;
  for (const i of [16, 20, 24, 28]) {
    const s = bf(i);
    const len = bf(i + 2) - s;
    const p = (frame - s) / len;
    if (p >= 0 && p < 1) {
      const up = p < 0.12 ? easeOut(p / 0.12) : p < 0.45 ? 1 : 1 - easeLock(Math.min(1, (p - 0.45) / 0.25));
      lift = 0.28 + 0.62 * up;
      push = (p < 0.1 ? easeOut(p / 0.1) : Math.max(0, 1 - (p - 0.1) / 0.6)) * 0.06;
    }
  }
  const fw = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
  const fl = Math.hypot(fw[0], fw[1], fw[2]);
  pos = [pos[0] + (fw[0] / fl) * push, pos[1] + (fw[1] / fl) * push, pos[2] + (fw[2] / fl) * push];

  // 光
  const glowR = frame < bf(0) ? 0.9 * prog(frame, 0.95 * FPS, b0 * FPS - 6, easeInOut) : 0.9;
  const glowLOn = prog(frame, bf(0) - 1, bf(0) + 7, easeLock);
  const glowL = 0.75 * glowLOn;
  const key = prog(frame, bf(3), bf(14), easeInOut);
  const sweep = lerp(-1.6, 0.5, prog(frame, bf(2), bf(30), easeInOut));
  const rim = prog(frame, bf(6), bf(16), easeInOut) * 1.1;
  const diveGlow = prog(frame, bf(30), bf(32) - 2, easeIn);
  const exposure = 1 + 2.2 * diveGlow;

  const flickL = 0.9 * punch(frame, FILL_L, 9);
  const flickR = 0.9 * punch(frame, FILL_R, 9);

  const state: LockState = {
    cam: { pos, target, roll, fov: 2.4 },
    lift,
    sweep,
    key: key * 1.05,
    rim,
    glowL: (glowL + flickL) * (1 + diveGlow * 2),
    glowR: (glowR + flickR) * (1 + diveGlow * 5),
    exposure,
    time: frame,
  };

  // 最后两帧冲白
  const white = prog(frame, bf(32) - 5, bf(32), easeIn);

  return (
    <AbsoluteFill style={{ background: '#050403' }}>
      <CinematicLock width={1920} height={1080} state={state} />
      <Vignette strength={0.55} />
      <Credit frame={frame} />
      <Lines frame={frame} />
      <Grain opacity={0.09} />
      <AbsoluteFill style={{ background: 'oklch(0.97 0.012 80)', opacity: white }} />
    </AbsoluteFill>
  );
}

function Credit({ frame }: { frame: number }) {
  const inP = prog(frame, bf(4), bf(6), easeOut);
  const outP = prog(frame, bf(12), bf(14), easeInOut);
  const o = inP * (1 - outP);
  if (o <= 0) return null;
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 46 }}>
      <div
        style={{
          fontFamily: 'var(--font-geist-sans)', fontSize: 14, letterSpacing: '0.55em', color: 'oklch(0.85 0.01 80)',
          opacity: o * 0.75, transform: `translateY(${(1 - inP) * 8}px)`,
        }}
      >
        FUNK&amp;LOVE&nbsp;&nbsp;·&nbsp;&nbsp;ZJU DFM
      </div>
    </AbsoluteFill>
  );
}

/** "想法很轻，" / "落地很重。"：一个字一个字砸在音头上 */
function Lines({ frame }: { frame: number }) {
  const out = prog(frame, bf(29), bf(30) + 10, easeInOut);
  const line = (text: string, at: number[], y: number, dx: number) => {
    if (frame < at[0]) return null;
    const chars = [...text];
    return (
      <div
        style={{
          position: 'absolute', left: 170 + dx, top: y, display: 'flex',
          fontFamily: 'var(--font-serif-sc)', fontWeight: 500, fontSize: 64, letterSpacing: '0.14em',
          color: 'oklch(0.95 0.012 80)', opacity: 1 - out, filter: out > 0 ? `blur(${out * 8}px)` : undefined,
          textShadow: '0 0 30px oklch(0.8 0.1 60 / 0.25)',
        }}
      >
        {chars.map((ch, i) => {
          // 标点跟着最后一个字一起落
          const f = at[Math.min(i, at.length - 1)];
          const p = prog(frame, f, f + 9, easeLock);
          return (
            <span key={i} style={{ display: 'inline-block', opacity: Math.min(1, p * 2), transform: `translateY(${(1 - p) * -22}px)`, filter: p < 1 ? `blur(${(1 - p) * 6}px)` : undefined }}>
              {ch}
            </span>
          );
        })}
      </div>
    );
  };
  return (
    <AbsoluteFill>
      {line('想法很轻，', LINE1, 420, 0)}
      {line('落地很重。', LINE2, 530, 64)}
    </AbsoluteFill>
  );
}
