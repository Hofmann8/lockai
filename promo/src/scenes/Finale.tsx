import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Camera, depthOf, dof, Grain, Plane, Vignette, lerp, type Cam } from '../lib/stage';
import { beat, bf, easeIn, easeInOut, easeLock, easeOut, FPS, MARKS, prog, rand, sf } from '../lib/time';
import { hits, punch, steps } from '../lib/hits';
import { near, pts } from '../lib/taps';

/*
 * 这一段全部卡在手打的点上（src/taps.json），配乐是原曲 176.26s 那一下真停顿。
 */
/** 走廊：九件作品，剪辑点之后一件一个点（71–72 秒那串八分音符连着落四件） */
const ITEM_AT = pts(70.5, 73.9);
/** 甩镜头之前吉他的三下：镜头连顶三下 */
const PRE_WHIP = [sf(74.01), near(74.24), sf(74.51)];
/** 墙：贝斯每推一下，墙跟着颤一下 */
const WALL_BASS = hits(['bass'], 141.2, 146, 0.45).map((h) => h.f);
/** 墙收成锁身的四步：75.31 / 75.67 / 76.27 / 76.81 */
const CONVERGE_AT = pts(75.1, 77);
/** 停之前最后一下：锁梁往上顶，犹豫 */
const LAST = near(77.33);
/** 重音之后三拍：拼图一拍一组翻成纸色 */
const SOLID_AT = pts(78.1, 79.6);
import { AppFrame } from '../ui/app';
import { SheetGrid } from '../ui/viewers';
import { Wordmark } from '../ui/kit';
import {
  AMBER, HandbookPage, INK, Landing, PAPER, Poster, SlideBudget, SlideCover, SlideFlow, SlideWhy,
} from '../art/works';
import { BUDGET_ROWS } from './Make';
import { SESSION_TITLE } from './Ask';

/*
 * 高潮与收尾（69.6 – 85s）
 * 剪辑点一刀切进暗场：做出来的东西一件件在拍子上"锁"进空间，镜头一路往前推。
 * JB 那声喊上一记甩镜头，所有作品散成一面墙；接下来四拍，墙按"抬—停"一步步收紧，拼成锁身，锁梁画出来、抬着。
 * 音乐停住——画面也停住："停一拍，"。重音砸下来，锁梁落下："再落下。"
 * 最后拼图的每一块翻成纸色，整把锁就是 LockAI 的标，退到字标上面。
 */

export const FINALE_START = sf(MARKS.cut);
export const FINALE_END = Math.ceil(MARKS.total * FPS);

const STOP = sf(MARKS.stop);
const HIT = sf(MARKS.hit);
const WHIP = near(74.72);
const SOLID = SOLID_AT[0];
const SOLID_END = SOLID_AT[2] + 12;
/** 退远、缩到字标上面：79.84 起，80.37 字标落下 */
const SHRINK = near(79.84) - 6;
const WORD_AT = near(80.37);
const VER_AT = near(80.85);
const TAG_AT = [near(81.64), near(81.87)];
const CREDIT_AT = [near(83.66), near(83.87)];

const BG = 'oklch(0.13 0.006 60)';
const STAGE_BG = 'radial-gradient(ellipse 80% 70% at 50% 42%, oklch(0.2 0.008 60), oklch(0.13 0.006 60) 65%, oklch(0.085 0.004 60))';

/* ---------------- 作品 ---------------- */

function SheetCard() {
  return (
    <div className="light" style={{ width: 720, height: 420, borderRadius: 14, overflow: 'hidden', fontFamily: 'var(--font-sans)' }}>
      <SheetGrid rows={BUDGET_ROWS} numeric={[false, false, true, true, false]} total={10} cols={5} sheet="预算" sheets={['预算', '报名名单', '物料清单']} />
    </div>
  );
}
function Phone() {
  return (
    <div className="light" style={{ width: 390, height: 760, borderRadius: 28, overflow: 'hidden', boxShadow: '0 0 0 8px oklch(0.2 0.01 60 / 0.95)' }}>
      <Landing filled={1} done={1} count={187} />
    </div>
  );
}
function AppHero({ g }: { g: number }) {
  return (
    <AppFrame frame={g} title={SESSION_TITLE} newSession={{ title: SESSION_TITLE, active: true }}>
      <div className="absolute inset-x-0 top-10 mx-auto w-full max-w-[46rem] px-6">
        <div className="md"><p>五个文件我都逐个截图检查过：日期、地点和二维码处处一致，PPT 第 3 页的总预算和 Excel 对得上，都是 ¥12,480。</p></div>
      </div>
    </AppFrame>
  );
}

interface Item { w: number; h: number; s: number; node: (g: number) => ReactNode }
const ITEMS: Item[] = [
  { w: 1131, h: 1600, s: 0.44, node: () => <Poster /> },
  { w: 1600, h: 900, s: 0.5, node: () => <SlideCover /> },
  { w: 390, h: 760, s: 1, node: () => <Phone /> },
  { w: 1600, h: 900, s: 0.5, node: () => <SlideBudget /> },
  { w: 720, h: 420, s: 1, node: () => <SheetCard /> },
  { w: 794, h: 1123, s: 0.62, node: () => <HandbookPage /> },
  { w: 1600, h: 900, s: 0.5, node: () => <SlideWhy /> },
  { w: 1600, h: 960, s: 0.5, node: (g) => <AppHero g={g} /> },
  { w: 1600, h: 900, s: 0.5, node: () => <SlideFlow /> },
];
const SPACING = 480;
const ITEM_POS = ITEMS.map((_, i) => ({
  x: i === 0 ? -170 : (i % 2 ? 1 : -1) * (430 + (i % 3) * 60),
  y: [10, 90, -40, 150, -150, 60, -70, 120, -20][i],
  ry: (i % 2 ? -1 : 1) * 17,
  rz: (rand(i + 3) - 0.5) * 4,
}));

/* ---------------- 拼图锁 ---------------- */

const K = 900 / 19; // 锁标 viewBox 单位 → 世界像素
const BODY_W = 19 * K;
const BODY_H = 14.5 * K;
const BODY_R = 4.6 * K;
const BODY_Y = 120; // 锁身中心
const BODY_TOP = BODY_Y - BODY_H / 2;
const COLS = 5;
const ROWS = 4;
const GAP = 10;
const TILE_W = (BODY_W - GAP * (COLS - 1)) / COLS;
const TILE_H = (BODY_H - GAP * (ROWS - 1)) / ROWS;

type Crop = { work: 'poster' | 'cover' | 'why' | 'budget' | 'flow' | 'landing' | 'hand'; cx: number; cy: number; s: number };
const CROPS: Crop[] = [
  { work: 'poster', cx: 380, cy: 470, s: 0.3 }, { work: 'cover', cx: 1250, cy: 780, s: 0.3 }, { work: 'budget', cx: 760, cy: 420, s: 0.24 },
  { work: 'landing', cx: 195, cy: 150, s: 0.55 }, { work: 'poster', cx: 560, cy: 1280, s: 0.24 },
  { work: 'hand', cx: 380, cy: 420, s: 0.36 }, { work: 'flow', cx: 800, cy: 470, s: 0.22 }, { work: 'why', cx: 800, cy: 660, s: 0.28 },
  { work: 'poster', cx: 1000, cy: 160, s: 0.5 }, { work: 'landing', cx: 195, cy: 470, s: 0.5 },
  { work: 'cover', cx: 330, cy: 380, s: 0.24 }, { work: 'budget', cx: 1380, cy: 160, s: 0.46 }, { work: 'poster', cx: 880, cy: 1510, s: 0.5 },
  { work: 'hand', cx: 380, cy: 960, s: 0.4 }, { work: 'why', cx: 420, cy: 300, s: 0.28 },
  { work: 'landing', cx: 195, cy: 640, s: 0.55 }, { work: 'poster', cx: 620, cy: 820, s: 0.22 }, { work: 'flow', cx: 420, cy: 520, s: 0.3 },
  { work: 'cover', cx: 420, cy: 700, s: 0.36 }, { work: 'budget', cx: 330, cy: 190, s: 0.38 },
];
const WORK_NODE: Record<Crop['work'], () => ReactNode> = {
  poster: () => <Poster />,
  cover: () => <SlideCover />,
  why: () => <SlideWhy />,
  budget: () => <SlideBudget />,
  flow: () => <SlideFlow />,
  landing: () => <Landing filled={1} done={1} count={187} />,
  hand: () => <HandbookPage />,
};

/** 锁身圆角矩形在某一块拼图自己坐标里的轮廓（裁掉四角） */
function bodyClip(tx: number, ty: number, w: number, h: number) {
  const x0 = -tx;
  const y0 = -ty;
  const x1 = x0 + BODY_W;
  const y1 = y0 + BODY_H;
  const r = BODY_R;
  void w; void h;
  return `path('M ${x0 + r} ${y0} H ${x1 - r} A ${r} ${r} 0 0 1 ${x1} ${y0 + r} V ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1} H ${x0 + r} A ${r} ${r} 0 0 1 ${x0} ${y1 - r} V ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0} Z')`;
}

/** 散开的程度：墙（1.9）→ 四个点一步步收紧 → 1 */
function spreadAt(g: number) {
  const levels = [1.9, 1.62, 1.38, 1.17, 1];
  let s = levels[0];
  for (let k = 1; k < levels.length; k += 1) {
    const p = prog(g, CONVERGE_AT[k - 1], CONVERGE_AT[k - 1] + 14, easeLock);
    s = lerp(s, levels[k], p);
  }
  return s;
}

/** 锁梁抬起的高度（锁标单位）：收拢时抬着犹豫，停住，重音上砸下来 */
function liftAt(g: number) {
  // 提前 3 帧开始落，easeLock 在一半处就到底——锁梁正好在重音的那一帧"咔"地扣上
  if (g >= HIT - 3) return lerp(5.6, 1.6, easeLock(Math.min(1, (g - HIT + 3) / 6)));
  // 停之前最后一下：再往上顶一下，停住——犹豫
  const hes = prog(g, LAST, LAST + 8, easeOut);
  return 4.6 + 1.0 * hes;
}

/* ---------------- 场景 ---------------- */

export function Finale() {
  const local = useCurrentFrame();
  const g0 = local + FINALE_START;
  // 停住：从 STOP 到 HIT 画面完全静止
  const g = g0 >= STOP && g0 < HIT ? STOP : g0;

  const whipOut = prog(g, WHIP - 10, WHIP, easeIn);
  const whipIn = 1 - prog(g, WHIP, WHIP + 16, easeOut);
  const inCorridor = g < WHIP;

  return (
    <AbsoluteFill style={{ background: BG }}>
      <AbsoluteFill style={{ background: STAGE_BG }} />
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse 60% 30% at 50% 108%, oklch(0.745 0.138 56 / 0.16), transparent 70%)' }} />
      {inCorridor ? <Corridor g={g} whip={whipOut} /> : <Mosaic g={g} g0={g0} whip={whipIn} />}
      <Texts g={g0} />
      <EndCard g={g0} />
      <Vignette strength={0.55} />
      <Grain opacity={0.08} />
      {/* 重音上的一下暖光 */}
      <AbsoluteFill style={{ background: 'oklch(0.8 0.12 60)', mixBlendMode: 'screen', opacity: 0.22 * (1 - prog(g0, HIT, HIT + 16, easeOut)) * (g0 >= HIT ? 1 : 0) }} />
      <AbsoluteFill style={{ background: '#000', opacity: prog(g0, FINALE_END - 42, FINALE_END - 2, easeInOut) }} />
    </AbsoluteFill>
  );
}

/** 走廊：作品一拍一件锁进来，镜头匀速往前推 */
function Corridor({ g, whip }: { g: number; whip: number }) {
  const b = (g / FPS - beat(131)) / (beat(132) - beat(131)) + 131;
  const accel = prog(g, ITEM_AT[8], WHIP, easeIn);

  const cam: Cam = {
    x: Math.sin(g / 70) * 40 + whip * 700,
    y: Math.sin(g / 90) * 20,
    z: 2200 - 90 * punch(g, PRE_WHIP, 10) - 50 * punch(g, ITEM_AT, 10),
    ry: Math.sin(g / 80) * 3 + whip * 70,
    rz: Math.sin(g / 110) * 1.2,
    persp: 1800,
  };
  // 每件作品落下时的纵深；焦点跟着最新落下的那件走（旧的飞近镜头、虚掉）
  const zOf = (i: number) => {
    const at = ITEM_AT[i];
    const p = prog(g, at - 2, at + 16, easeLock);
    const bi = (at / FPS - beat(131)) / (beat(132) - beat(131)) + 131;
    return { p, z: 250 + (b - bi) * SPACING + accel * 420 - (1 - p) * 500 };
  };
  let newest = 0;
  ITEM_AT.forEach((at, i) => { if (g >= at - 2) newest = i; });
  const focusTo = (i: number) => depthOf(cam, [ITEM_POS[i].x, ITEM_POS[i].y, zOf(i).z]);
  // 换焦用 8 帧过渡，不跳
  const prevAt = ITEM_AT[newest];
  const focus = newest > 0 ? lerp(focusTo(newest - 1), focusTo(newest), prog(g, prevAt - 2, prevAt + 6, easeOut)) : focusTo(0);
  return (
    <AbsoluteFill style={{ filter: whip > 0.05 ? `blur(${whip * 18}px)` : undefined }}>
      <Camera cam={cam}>
        {ITEMS.map((it, i) => {
          const { p, z } = zOf(i);
          if (p <= 0) return null;
          const pos = ITEM_POS[i];
          if (z > 2050) return null;
          const fade = 1 - prog(z, 1500, 2000, (x) => x);
          const depth = depthOf(cam, [pos.x, pos.y, z]);
          const blur = dof(depth, focus, 0.01) + (1 - p) * 10;
          return (
            <Plane key={i} w={it.w} h={it.h} x={pos.x} y={pos.y} z={z} ry={pos.ry} rz={pos.rz} scale={it.s * lerp(1.08, 1, p)} blur={blur} opacity={Math.min(1, p * 1.8) * fade}>
              <div style={{ width: it.w, height: it.h, boxShadow: '0 60px 120px -40px oklch(0 0 0 / 0.8)', borderRadius: 6, overflow: 'hidden' }}>{it.node(g)}</div>
            </Plane>
          );
        })}
      </Camera>
    </AbsoluteFill>
  );
}

/** 墙 → 锁 → 标 */
function Mosaic({ g, g0, whip }: { g: number; g0: number; whip: number }) {
  const s = spreadAt(g);
  const lift = liftAt(g0 >= STOP && g0 < HIT - 3 ? STOP : g0);
  const solid = steps(g0, SOLID_AT, 10) / 3;
  const shrink = prog(g0, SHRINK, SHRINK + 70, easeInOut);
  const draw = prog(g, CONVERGE_AT[2], CONVERGE_AT[3] + 10, easeInOut);
  const slots = prog(g, CONVERGE_AT[3], CONVERGE_AT[3] + 16, easeLock);

  // 镜头：甩进来 → 慢推 → 停 → 重音一震 → 退远、标移到画面上方
  const settle = prog(g, WHIP, STOP, easeInOut);
  const jolt = g0 >= HIT ? Math.exp(-(g0 - HIT) / 5) * Math.sin((g0 - HIT) * 1.9) * 14 : 0;
  const markCenterY = BODY_TOP - (355 + 57) / 2 + BODY_H / 2 - 40;
  let cam: Cam = {
    x: lerp(60, 330, settle),
    y: lerp(-120, markCenterY + 30, settle) + jolt,
    z: lerp(3700, 3450, settle) - prog(g0, HIT, SHRINK, easeOut) * 120 - 70 * punch(g, [...WALL_BASS, ...CONVERGE_AT], 12) - 50 * punch(g0, SOLID_AT, 12),
    ry: lerp(-7, -3, settle) - whip * 70,
    rx: lerp(6, 2, settle),
    rz: lerp(-1.5, 0, settle),
    persp: 2200,
  };
  // 收尾：锁回到正中、缩小，放到字标上面（屏幕 y≈380）
  const endZ = 7400;
  const endScale = 2200 / endZ;
  cam = {
    ...cam,
    x: lerp(cam.x, 0, shrink),
    y: lerp(cam.y, markCenterY + (540 - 330) / endScale, shrink),
    z: lerp(cam.z, endZ, shrink),
    ry: lerp(cam.ry ?? 0, 0, shrink),
    rx: lerp(cam.rx ?? 0, 0, shrink),
  };

  const tiles: ReactNode[] = [];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const k = r * COLS + c;
      const crop = CROPS[k];
      const tx = c * (TILE_W + GAP);
      const ty = r * (TILE_H + GAP);
      const fx = -BODY_W / 2 + tx + TILE_W / 2;
      const fy = BODY_Y - BODY_H / 2 + ty + TILE_H / 2;
      const loose = (s - 1) / 0.9;
      const jz = ((rand(k * 7.1) - 0.5) * 700 + Math.sin(g / 34 + k * 1.7) * 60) * loose;
      const jr = (rand(k * 3.3) - 0.5) * 16 * loose;
      // 甩进来的时候一块块落进墙里
      const appear = prog(g, WHIP + (k % 7) * 2, WHIP + (k % 7) * 2 + 16, easeLock);
      const grow = GAP * solid;
      const w = TILE_W + grow;
      const h = TILE_H + grow;
      const workW = crop.work === 'poster' ? 1131 : crop.work === 'landing' ? 390 : crop.work === 'hand' ? 794 : 1600;
      void workW;
      tiles.push(
        <Plane key={k} w={w} h={h} x={fx * s} y={BODY_Y + (fy - BODY_Y) * s} z={jz - (1 - appear) * 600} rz={jr} ry={jr * 0.6} opacity={appear * (1 - prog(g0, SOLID_END, SOLID_END + 10, (x) => x))}>
          <div style={{ width: w, height: h, position: 'relative', overflow: 'hidden', clipPath: bodyClip(tx - grow / 2, ty - grow / 2, w, h), background: PAPER }}>
            <div style={{ position: 'absolute', left: w / 2 - crop.cx * crop.s, top: h / 2 - crop.cy * crop.s, transform: `scale(${crop.s})`, transformOrigin: '0 0' }}>
              {WORK_NODE[crop.work]()}
            </div>
            <div style={{ position: 'absolute', inset: 0, background: PAPER, opacity: prog(g0, SOLID_AT[(c + r * 2) % 3] + (k % 4), SOLID_AT[(c + r * 2) % 3] + (k % 4) + 8, easeOut) }} />
          </div>
        </Plane>,
      );
    }
  }

  // 锁孔两道竖槽：左边亮白 → 标里是底色；右边琥珀
  const glow = 1 + 1.6 * (g0 >= HIT ? Math.exp(-(g0 - HIT) / 14) : 0);
  const slotH = 6.4 * K;
  const slotW = 1.7 * K;
  const slotY = BODY_TOP + 4 * K + slotH / 2;
  const leftColor = solid > 0.5 ? BG : 'oklch(0.97 0.01 80)';

  return (
    <AbsoluteFill style={{ filter: whip > 0.05 ? `blur(${whip * 18}px)` : undefined }}>
      <Camera cam={cam}>
        {solid > 0 && (
          <Plane w={BODY_W} h={BODY_H} y={BODY_Y} z={-1} opacity={solid}>
            <div style={{ width: '100%', height: '100%', borderRadius: BODY_R, background: PAPER }} />
          </Plane>
        )}
        {tiles}
        {slots > 0 && (
          <>
            <Plane w={slotW} h={slotH} x={-BODY_W / 2 + (13.6 - 6.5) * K + slotW / 2} y={slotY} z={3} scale={1} opacity={slots}>
              <div style={{ width: '100%', height: '100%', borderRadius: slotW / 2, background: leftColor, transform: `scaleY(${slots})`, boxShadow: solid > 0.5 ? undefined : `0 0 ${60 * glow}px oklch(0.97 0.01 80 / ${0.5 * glow})` }} />
            </Plane>
            <Plane w={slotW} h={slotH} x={-BODY_W / 2 + (16.7 - 6.5) * K + slotW / 2} y={slotY} z={3} opacity={slots}>
              <div style={{ width: '100%', height: '100%', borderRadius: slotW / 2, background: AMBER, transform: `scaleY(${slots})`, boxShadow: `0 0 ${80 * glow}px oklch(0.745 0.16 58 / ${0.7 * Math.min(1.6, glow)})` }} />
            </Plane>
          </>
        )}
        {/* 锁梁：锁标同一条路径，viewBox 32，按 K 放大 */}
        {draw > 0.015 && (
          <Plane w={32 * K} h={32 * K} x={0} y={BODY_TOP + (16 - 14) * K} z={2}>
            <svg width={32 * K} height={32 * K} viewBox="0 0 32 32" style={{ overflow: 'visible' }}>
              <g style={{ transform: `translateY(${-lift}px)` }}>
                <path
                  d="M11 15V11.5a5 5 0 0 1 10 0V13"
                  stroke={PAPER}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  fill="none"
                  pathLength={1}
                  strokeDasharray="1 2"
                  strokeDashoffset={1 - draw}
                  style={{ filter: 'drop-shadow(0 0 0.6px oklch(1 0 0 / 0.4))' }}
                />
              </g>
            </svg>
          </Plane>
        )}
      </Camera>
    </AbsoluteFill>
  );
}

/** "停一拍，" / "再落下。"：和开场的两行呼应，放在锁的右边 */
function Texts({ g }: { g: number }) {
  const out = prog(g, SOLID_AT[1] - 10, SOLID_AT[1] + 16, easeInOut);
  const line = (text: string, at: number, y: number, dx: number, instant?: boolean) => {
    if (g < at) return null;
    const p = instant ? prog(g, at, at + 6, easeLock) : prog(g, at, at + 18, easeLock);
    return (
      <div
        style={{
          position: 'absolute', left: 1180 + dx, top: y,
          fontFamily: 'var(--font-serif-sc)', fontWeight: 500, fontSize: 64, letterSpacing: '0.14em',
          color: 'oklch(0.95 0.012 80)', opacity: Math.min(1, p) * (1 - out),
          transform: `translateY(${(1 - p) * (instant ? -26 : 12)}px)`, filter: `blur(${(1 - Math.min(1, p)) * 6 + out * 8}px)`,
          textShadow: '0 0 30px oklch(0.8 0.1 60 / 0.25)',
        }}
      >
        {text}
      </div>
    );
  };
  return (
    <AbsoluteFill>
      {line('停一拍，', STOP + 2, 420, 0)}
      {line('再落下。', HIT, 530, 64, true)}
    </AbsoluteFill>
  );
}

/** 字标 + 口号 + 署名 */
function EndCard({ g }: { g: number }) {
  if (g < WORD_AT - 2) return null;
  const word = prog(g, WORD_AT - 2, WORD_AT + 22, easeLock);
  const ver = prog(g, VER_AT, VER_AT + 16, easeLock);
  const tag = TAG_AT.map((f) => prog(g, f - 1, f + 14, easeLock));
  const credit = CREDIT_AT.map((f) => prog(g, f - 1, f + 16, easeOut));
  return (
    <AbsoluteFill className="dark" style={{ alignItems: 'center', background: 'transparent' }}>
      <div style={{ position: 'absolute', top: 566, display: 'flex', alignItems: 'baseline', gap: 22 }}>
        <Wordmark style={{ opacity: word, transform: `translateY(${(1 - word) * 18}px)`, filter: `blur(${(1 - word) * 6}px)`, color: 'oklch(0.96 0.008 80)', fontSize: 120 }} />
        <span style={{ fontFamily: 'var(--font-geist-sans)', fontWeight: 300, fontSize: 56, color: 'var(--accent)', opacity: ver, transform: `translateX(${(1 - ver) * -14}px)` }}>1.0</span>
      </div>
      <div style={{ position: 'absolute', top: 738, display: 'flex', fontFamily: 'var(--font-serif-sc)', fontSize: 40, letterSpacing: '0.32em', color: 'oklch(0.9 0.01 80)' }}>
        {['让想法，', '落地。'].map((t, i) => (
          <span key={t} style={{ opacity: Math.min(1, tag[i] * 1.5), transform: `translateY(${(1 - tag[i]) * (i ? -14 : 10)}px)`, filter: tag[i] < 1 ? `blur(${(1 - tag[i]) * 5}px)` : undefined }}>{t}</span>
        ))}
      </div>
      <div style={{ position: 'absolute', bottom: 70, display: 'flex', gap: '0.9em', fontFamily: 'var(--font-geist-sans)', fontSize: 16, letterSpacing: '0.42em', color: 'oklch(0.8 0.01 80)' }}>
        {['CAMPBELL 3.0 · SCOOBY 2.0 ·', 'FUNK&LOVE · ZJU DFM'].map((t, i) => (
          <span key={t} style={{ opacity: credit[i] * 0.9 }}>{t}</span>
        ))}
      </div>
    </AbsoluteFill>
  );
}

void INK;
