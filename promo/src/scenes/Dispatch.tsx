import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { AppFrame } from '../ui/app';
import { DocCard, LiveSteps, StatusRow, TaskCard, UserBubble, type Kind } from '../ui/kit';
import { Camera, camPath, depthOf, dof, Grain, PaperLight, Plane, Vignette, lerp } from '../lib/stage';
import { beat, bf, easeIn, easeInOut, easeLock, easeOut, FPS, prog } from '../lib/time';
import { pts } from '../lib/taps';
import { hits, passed, pick, punch } from '../lib/hits';
import { BACKDROP, BACKDROP_GLOW, PROMPT, SESSION_TITLE } from './Ask';
import { wipeClip } from './Campbell';
import { Poster } from '../art/works';

/*
 * 派活（38.3 – 46.6s）
 * 计划里的四块活被派出去：四张执行卡片从左往右锁进空间里，各自的终端尾巴按八分音符往上滚。
 * 镜头沿着这条斜线推过去、焦点一张张跟；时间被压缩（右下角是真实用时）。
 * 卡片在 82 / 84 / 86 / 88 拍依次完成：转圈变成对勾，步骤收起，交付的文件从卡片下面滑出来。
 */

export const DISPATCH_WIPE = bf(72) - 6;
export const DISPATCH_START = DISPATCH_WIPE - 1;
export const DISPATCH_END = bf(88) + 2;

export interface Deliverable { name: string; meta: string; kind: Kind; img?: 'poster' }

export function PosterThumb() {
  return (
    <div style={{ width: 40, height: 40, overflow: 'hidden' }}>
      <div style={{ transform: 'scale(0.0354)', transformOrigin: '0 0' }}><Poster /></div>
    </div>
  );
}

export const TASKS: {
  title: string; done: number; sub: string[]; total: number; lines: string[]; file: Deliverable; pos: [number, number, number];
}[] = [
  {
    title: '主视觉海报', done: bf(80), total: 492,
    sub: ['读 PLAN.md 与配色规范', '排三版构图草稿', '定稿：同心弧 + Winter Jam', '导出 A2 印刷版', '导出手机竖版并自检'],
    lines: [
      '$ python compose.py --size A2 --bleed 3mm', 'layout: arcs × 6 · type: Fraunces 144', 'draft 1/3 … saved', 'draft 2/3 … saved', 'draft 3/3 … saved',
      'pick → draft 3（留白最多）', 'fonts embedded: Fraunces, Noto Serif SC', 'qr → lockai.funkandlove.cn/jam ok', 'export poster_A2.pdf  12.4 MB', 'export poster_mobile.png 1080×1920', 'screenshot check 3/3 ✓',
    ],
    file: { name: '冬季 Jam 主视觉.png', meta: 'PNG · 1131 × 1600', kind: 'image', img: 'poster' },
    pos: [-560, -300, -180],
  },
  {
    title: '预算表与报名数据', done: bf(82), total: 371,
    sub: ['整理报价与往届账目', '建三张工作表', '写公式并交叉核对', '导入报名名单', '导出 Excel'],
    lines: [
      '$ python build_budget.py', 'quotes: 7 items from 4 sources', 'sheet 预算 … 7 rows', 'sheet 报名名单 … 186 rows', 'sheet 物料清单 … 12 rows',
      'SUM(D2:D8) = 12480', 'cross-check vs 往届账目 Δ −6.2%', 'formulas: 0 errors', 'freeze header · number format ¥', 'saved 冬季Jam预算.xlsx  48 KB',
    ],
    file: { name: '冬季 Jam 预算与报名.xlsx', meta: 'Excel · 3 个工作表', kind: 'sheet' },
    pos: [-110, -40, -20],
  },
  {
    title: '宣讲 PPT', done: bf(84), total: 618,
    sub: ['读海报与预算的结果', '搭 8 页结构', '排版：封面 / 预算 / 流程', '渲染预览逐页自检', '导出 PPTX'],
    lines: [
      '$ node build_deck.mjs --theme winter-jam', 'palette ← 主视觉海报', 'slide 1/8 cover … ok', 'slide 2/8 why jam … ok', 'slide 3/8 budget ← 冬季Jam预算.xlsx',
      'slide 4/8 rundown … ok', 'slide 5–8 … ok', 'render preview → 8 screenshots', 'check: 字号 ≥ 24 · 对比度 ok', 'saved 招新宣讲.pptx  8 slides',
    ],
    file: { name: '冬季 Jam 招新宣讲.pptx', meta: 'PPT · 8 页', kind: 'ppt' },
    pos: [340, 220, 140],
  },
  {
    title: '报名网页', done: bf(86), total: 544,
    sub: ['写表单与名额计数', '接海报的配色和字体', '手机 / 桌面截图自检', '生成二维码', '打包单文件网页'],
    lines: [
      '$ npm run build', '✓ form: 姓名 / 学院 / 想参加', '✓ counter: 186 / 240', 'screenshot 390×844 … ok', 'screenshot 1440×900 … ok',
      'fix: 按钮在小屏换行 → ok', 'a11y 98 · perf 100', 'qr → /jam  ok', 'inline assets 38 KB', 'saved jam-signup.html',
    ],
    file: { name: '报名页 · 冬季 Jam.html', meta: '网页 · 手机 / 桌面', kind: 'html' },
    pos: [790, 480, 300],
  },
];

/** 四张卡片按 72 拍那串吉他十六分音符依次锁进来 */
const ARRIVE_AT = pick(hits(['other', 'bass', 'vocals'], 72, 73), 4, 72, 73, 4);
/**
 * 终端的每一行都落在一个音头上（贝斯 / 吉他 / 铜管），音头轮流分给还在跑的卡片——
 * 看起来像一台音序器，四个终端此起彼伏。
 */
const LINE_AT: number[][] = (() => {
  const out: number[][] = TASKS.map(() => []);
  const list = hits(['bass', 'other'], 72.75, 86, 0.35);
  let k = 0;
  for (const h of list) {
    for (let tries = 0; tries < 4; tries += 1) {
      const i = (k + tries) % 4;
      const t = TASKS[i];
      if (h.f < t.done - 4 && h.f > ARRIVE_AT[i] + 6 && out[i].length < t.lines.length - 1) {
        out[i].push(h.f);
        k = i + 1;
        break;
      }
    }
  }
  return out;
})();

const CARD_W = 640;
const CARD_H = 250;
/** 真实用时：卡片跑完这一段，钟走了 14 分多钟 */
const CLOCK_SECONDS = 866;

/** 42.88 / 43.26 两下切分 */
const SYNC_AT = pts(42.7, 43.4);

export function Dispatch() {
  const local = useCurrentFrame();
  const g = local + DISPATCH_START;
  const S = bf(72);
  const eighth = (beat(74) - beat(72)) / 4 * FPS;

  // 镜头：先看第一张，沿斜线一路推过去，最后退开看全貌（x/y 是镜头看着的点）
  const path = camPath(g, [
    [DISPATCH_WIPE, { x: -640, y: -340, z: 1180, ry: -20, rx: 6, rz: -1.5 }],
    [bf(75), { x: -430, y: -230, z: 1380, ry: -17, rx: 5, rz: -1 }],
    [bf(78), { x: -40, y: 0, z: 1420, ry: -12, rx: 4, rz: 0 }],
    [bf(81), { x: 370, y: 230, z: 1450, ry: -8, rx: 3 }],
    [bf(84), { x: 700, y: 430, z: 1520, ry: -4, rx: 2 }],
    [bf(88) + 2, { x: 250, y: 160, z: 2700, ry: 6, rx: 3, rz: 0.6 }],
  ]);
  // 78 拍那两下切分（手打的点）：镜头顿两下
  const cam = { ...path, z: path.z * (1 - 0.03 * punch(g, SYNC_AT, 12)) };
  // 焦点：跟着离取景中心最近的那张卡（按距离加权，换焦是平滑的）
  let wsum = 0;
  let dsum = 0;
  TASKS.forEach((t) => {
    const cx = t.pos[0] + CARD_W / 2 - CARD_W / 2;
    const d2 = ((cx - cam.x) ** 2 + (t.pos[1] - cam.y) ** 2) / (260 * 260);
    const w = Math.exp(-d2);
    wsum += w;
    dsum += w * depthOf(cam, t.pos);
  });
  const focusDist = dsum / Math.max(1e-6, wsum);
  const pull = prog(g, bf(85), bf(88), easeInOut);

  // 远处的那一屏：对话还在跑
  const farBlur = lerp(9, 4, pull);

  return (
    <AbsoluteFill style={{ clipPath: wipeClip(g, DISPATCH_WIPE) }}>
      <AbsoluteFill style={{ background: BACKDROP }} />
      <AbsoluteFill style={{ background: BACKDROP_GLOW }} />
      <Camera cam={cam}>
        <Plane w={1600} h={960} x={40} y={40} z={-1500} blur={farBlur} opacity={0.75}>
          <AppFrame frame={g} title={SESSION_TITLE} busy newSession={{ title: SESSION_TITLE, active: true, running: true }}>
            <div className="absolute inset-x-0 top-0 mx-auto w-full max-w-[46rem] px-6 pt-4">
              <UserBubble text={PROMPT} />
              <div className="md mt-6"><p>好，我把这件事拆成四块：主视觉、预算、宣讲和报名页。它们要共用同一套配色、文案和数据，我先把规范定下来，再分头去做，最后逐个检查。</p></div>
              <StatusRow label="四个执行助手正在工作" frame={g} seconds={(g - S) / FPS * 55} className="mt-3" />
            </div>
          </AppFrame>
        </Plane>

        {TASKS.map((t, i) => {
          const arrive = ARRIVE_AT[i];
          const p = prog(g, arrive, arrive + 22, easeLock);
          if (p <= 0) return null;
          const [x, y, z] = t.pos;
          const blur = dof(depthOf(cam, t.pos), focusDist, 0.012) * (1 - pull * 0.7);
          return (
            <Plane key={t.title} w={CARD_W} h={CARD_H} x={lerp(x - 420, x, p)} y={y} z={lerp(z - 300, z, p)} ry={lerp(-25, 0, p)} blur={blur} opacity={Math.min(1, p * 2)} res={2}>
              <Card t={t} g={g} i={i} eighth={eighth} />
            </Plane>
          );
        })}
      </Camera>
      <Clock g={g} />
      <PaperLight />
      <Vignette strength={0.18} color="60,45,30" />
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
}

function Card({ t, g, i, eighth }: { t: (typeof TASKS)[number]; g: number; i: number; eighth: number }) {
  const S = bf(72);
  const done = g >= t.done;
  // 终端：第一行随卡片出现，之后每个分到的音头出一行；新行出来时整块往上顶一下
  const L = t.lines.length;
  const at = LINE_AT[i];
  const k = passed(g, at);
  const n = Math.min(L, 2 + k);
  const since = k >= 0 ? g - at[k] : 99;
  const shift = k >= 0 ? 16.7 * (1 - easeLock(Math.min(1, since / 6))) : 0;
  const tail = t.lines.slice(Math.max(0, n - 5), n);
  // 步骤跟着终端走：输出到哪儿，步骤就到哪儿
  const p = done ? 0.999 : Math.min(0.999, n / L);
  const idx = Math.floor(p * t.sub.length);
  const shownFrom = Math.max(0, idx - 2);
  const steps = t.sub.slice(shownFrom, idx).map((title, j) => ({ title, seconds: 40 + ((j + i * 3) * 37) % 90 }));
  const seconds = done ? t.total : Math.max(0, (g - bf(72)) / (t.done - bf(72))) * t.total;
  void eighth;

  // 完成：步骤收起，文件滑出
  const collapse = prog(g, t.done, t.done + 14, easeInOut);
  const check = prog(g, t.done, t.done + 12, easeLock);
  const fileIn = prog(g, t.done + 6, t.done + 24, easeLock);
  const glow = done ? 1 - prog(g, t.done, t.done + 30, easeOut) : 0;

  return (
    <div className="light" style={{ width: CARD_W, fontFamily: 'var(--font-sans)', position: 'relative' }}>
      <div style={{ filter: 'drop-shadow(0 30px 40px oklch(0.3 0.03 50 / 0.22))' }}>
        <TaskCard
          title={t.title}
          state={done ? 'done' : 'running'}
          sub={done ? `${t.sub.length} 步 · 交付 1 个文件 · 看了 3 张截图自检` : t.sub[idx]}
          seconds={seconds}
          stepCount={done ? t.sub.length : idx + 1}
          frame={g}
          highlight={glow * 6}
          style={{ margin: 0, transform: done ? `scale(${1 + 0.02 * Math.sin(Math.PI * check)})` : undefined }}
        >
          <div style={{ maxHeight: lerp(200, 0, collapse), opacity: 1 - collapse, overflow: 'hidden' }}>
            <LiveSteps older={shownFrom} steps={steps} current={{ title: t.sub[idx] }} tail={tail} frame={g} shift={shift} />
          </div>
        </TaskCard>
      </div>
      {fileIn > 0 && (
        <div style={{ marginTop: 10, marginLeft: 24, width: 360, opacity: Math.min(1, fileIn * 1.6), transform: `translateY(${(1 - fileIn) * -26}px)`, filter: 'drop-shadow(0 20px 30px oklch(0.3 0.03 50 / 0.2))' }}>
          <DocCard name={t.file.name} meta={t.file.meta} kind={t.file.kind} img={t.file.img ? <PosterThumb /> : undefined} />
        </div>
      )}
    </div>
  );
}

/** 右下角：真实用时（时间被压缩的提示），细字、两道竖线 */
function Clock({ g }: { g: number }) {
  const inP = prog(g, bf(73), bf(74), easeOut);
  const outP = prog(g, bf(87), bf(88), easeIn);
  const run = prog(g, bf(73), bf(88), (x) => x);
  const secs = Math.round(CLOCK_SECONDS * run);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const o = inP * (1 - outP);
  if (o <= 0) return null;
  return (
    <div style={{ position: 'absolute', left: 84, bottom: 70, display: 'flex', alignItems: 'center', gap: 16, opacity: o, color: 'oklch(0.3 0.015 60)' }}>
      <div style={{ display: 'flex', gap: 3 }}>
        <span style={{ width: 2, height: 30, background: 'oklch(0.3 0.015 60)', borderRadius: 2 }} />
        <span style={{ width: 2, height: 30, background: 'var(--accent)', borderRadius: 2 }} />
      </div>
      <div>
        <div style={{ fontFamily: 'var(--font-geist-sans)', fontSize: 12, letterSpacing: '0.32em', opacity: 0.6 }}>实际用时</div>
        <div style={{ fontFamily: 'var(--font-geist-mono, monospace)', fontSize: 30, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
          {mm}:{ss}
        </div>
      </div>
    </div>
  );
}
