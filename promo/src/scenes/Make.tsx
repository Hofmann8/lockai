import type { ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { AppFrame, APP_H, APP_W } from '../ui/app';
import { ActionRow, Composer, DeliverablesHeader, DocCard, TaskCard } from '../ui/kit';
import { HtmlPhone, ImageViewer, imageFit, Panel, PANEL_W, PdfPages, pageTop, SheetGrid } from '../ui/viewers';
import { Camera, camPath, Grain, PaperLight, Plane, Vignette, lerp, type Cam } from '../lib/stage';
import { beat, bf, easeIn, easeInOut, easeLock, easeOut, FPS, MARKS, prog, sf } from '../lib/time';
import { hits, passed, pick, punch, steps } from '../lib/hits';
import { near, pts } from '../lib/taps';
import { BACKDROP, BACKDROP_GLOW, SESSION_TITLE } from './Ask';
import { PosterThumb, TASKS } from './Dispatch';
import {
  AMBER, BUDGET, BUDGET_TOTAL, DEEP, Landing, OCHRE, Poster, POSTER_H, POSTER_LAYERS, POSTER_W, RUST, SlideBudget, SlideCover, SlideFlow, SlideWhy,
  type PosterLayer,
} from '../art/works';

/*
 * 做出来（46.6 – 69.6s）
 * 一刀切回产品：做完的这条回答，交付文件排成两列。点开海报，右侧面板滑出来。
 * 海报从屏幕里"浮"出来，拆成前后错开的六层，镜头绕着转；同心弧一圈圈扩开，接到 PPT。
 * PPT 往下翻到预算页，柱子按八分音符一根根长出来；一记甩镜头到 Excel，合计那一格被圈出来；
 * 最后是手机上的报名页：填表，铜管重音上按下"立即报名"，镜头拉开看全貌——剪辑点，接高潮。
 */

export const MAKE_START = bf(88);
export const MAKE_END = sf(MARKS.cut);

const ANY = ['bass', 'other', 'vocals'] as const;
/** 面板在 91 拍后半的吉他重音上打开 */
const PANEL_OPEN = pick(hits([...ANY], 91.25, 92), 1, 91.25, 92)[0];
const EXPLODE = bf(96);
/** 海报六层：一层一个音头弹开 */
const LAYER_AT = pick(hits([...ANY], 96, 97.75), 6, 96, 97.75, 5);
/** 同心弧四圈 */
const IRIS_AT = pick(hits([...ANY], 100, 102), 4, 100, 102, 12);
const IRIS = IRIS_AT[0];
/** 55 秒那串八分音符（手打的点）：PPT 分四下露出来 */
const REVEAL_AT = pts(54.9, 55.9);
const PPT_IN = REVEAL_AT[0];
/** 紧接着的四个八分音符：翻页分四步，每步半页 */
const TURN_AT = pts(55.9, 56.9);
/** 预算柱：前四根一拍一根，最后三根赶在 59 秒那串快音上 */
const BAR_AT = pts(56.9, 59.6);
/** 甩镜头：59.76 起甩，60.07 落到 Excel */
const WHIP_OUT = near(59.76);
const WHIP = near(60.07);
/** Excel 的行分五下落定 */
const ROW_AT = pts(60, 61.2);
/** 合计格：116 拍的三连音，一圈一圈框住 */
const MARK_AT = pick(hits(['other', 'bass'], 116, 117), 3, 116, 117, 4);
/** 报名名单：63 秒那串快音上一格一格往下翻 */
const SCROLL_AT = pts(63, 63.9);
const HTML_IN = near(64.1);
/** 花名"霍夫曼"三个字、学院、Battle，各卡一个手打的点 */
const NAME_AT = pts(64.2, 65);
const COLLEGE_AT = near(65.11);
const BATTLE_AT = near(65.6);
/** 按下"立即报名"：Follow me 之后那记铜管 */
const PRESS = near(67.37);
/** 按完之后一步一步往后拉，一直拉到剪辑点 */
const PULL_AT = pts(67.5, 70.5);

/** 面板在世界坐标里的中心 x（应用平面中心在原点） */
const PANEL_X = APP_W - PANEL_W / 2 - APP_W / 2;
/** 应用坐标 → 世界坐标 */
const wy = (appY: number) => appY - APP_H / 2;

const FILES = [
  { ...TASKS[0].file, key: 'poster' },
  { ...TASKS[1].file, key: 'sheet' },
  { ...TASKS[2].file, key: 'ppt' },
  { ...TASKS[3].file, key: 'html' },
  { name: '冬季 Jam 执行手册.docx', meta: 'Word · 6 页', kind: 'doc' as const, key: 'doc' },
];

/* ---------------- 聊天栏：做完的这条回答 ---------------- */

function DoneMessage({ g, active, pressed = 0 }: { g: number; active?: string; pressed?: number }) {
  return (
    <>
      <div className="absolute inset-x-0 mx-auto w-full max-w-[46rem] px-6" style={{ bottom: 904 - 728 + 18 }}>
        <div className="md"><p>好，我把这件事拆成四块：主视觉、预算、宣讲和报名页。它们共用同一套配色、文案和数据。</p></div>
        {TASKS.map((t) => (
          <TaskCard key={t.title} title={t.title} state="done" sub={`${t.sub.length} 步 · 交付 1 个文件 · 看了 3 张截图自检`} seconds={t.total} stepCount={t.sub.length} frame={g} />
        ))}
        <section className="@container my-3">
          <DeliverablesHeader label="交付了 5 个文件" />
          <div className="grid gap-2 @lg:grid-cols-2">
            {FILES.map((f) => (
              <DocCard
                key={f.key}
                name={f.name}
                meta={f.meta}
                kind={f.kind}
                img={f.img ? <PosterThumb /> : undefined}
                active={active === f.key}
                style={active === f.key ? { transform: `scale(${1 - 0.03 * pressed})` } : undefined}
              />
            ))}
          </div>
        </section>
        <div className="md"><p>五个文件我都逐个截图检查过：日期、地点和二维码处处一致，PPT 第 3 页的总预算和 Excel 对得上，都是 ¥12,480。</p></div>
        <ActionRow />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 728 }}>
        <div className="relative mx-auto w-full max-w-[46rem]">
          <Composer variant="dock" text="" sendState="mic" />
        </div>
      </div>
    </>
  );
}

function App({ g, panel, panelW, active, pressed }: { g: number; panel?: ReactNode; panelW: number; active?: string; pressed?: number }) {
  return (
    <AppFrame frame={g} title={SESSION_TITLE} newSession={{ title: SESSION_TITLE, active: true }} panel={panel} panelW={panelW}>
      <DoneMessage g={g} active={active} pressed={pressed} />
    </AppFrame>
  );
}

/** punch：卡点时镜头往前顶一下（0–1） */
function Stage({ cam, children, filter, punch: pn = 0 }: { cam: Cam; children: ReactNode; filter?: string; punch?: number }) {
  const c = pn > 0 ? { ...cam, z: cam.z * (1 - 0.022 * pn) } : cam;
  return (
    <AbsoluteFill style={{ filter }}>
      <AbsoluteFill style={{ background: BACKDROP }} />
      <AbsoluteFill style={{ background: BACKDROP_GLOW }} />
      <Camera cam={c}>{children}</Camera>
    </AbsoluteFill>
  );
}

/* ---------------- 镜头 1：交付 → 海报 → 拆层 ---------------- */

const LAYER_Z: Record<PosterLayer, number> = { paper: 0, arcs: 90, band: 150, meta: 230, title: 360, tag: 460 };

function PosterShot({ g }: { g: number }) {
  const open = prog(g, PANEL_OPEN, PANEL_OPEN + 22, easeOut);
  const pressed = g >= PANEL_OPEN - 4 && g < PANEL_OPEN + 4 ? 1 - Math.abs(g - PANEL_OPEN) / 4 : 0;
  const explode = g >= LAYER_AT[0] ? 1 : 0;
  const fit = imageFit(POSTER_W, POSTER_H);
  const posterY = wy(fit.cy);

  const cam = camPath(g, [
    [MAKE_START, { x: 170, y: 110, z: 1050, ry: 16, rx: 9, rz: -1.2 }],
    [PANEL_OPEN, { x: 190, y: 70, z: 1300, ry: 8, rx: 5, rz: -0.4 }],
    [bf(94), { x: PANEL_X - 20, y: posterY, z: 2050, ry: -4, rx: 2 }],
    [EXPLODE, { x: PANEL_X, y: posterY, z: 1950, ry: -6, rx: 3 }],
    [bf(98), { x: PANEL_X + 40, y: posterY - 20, z: 1750, ry: -32, rx: 10, rz: 1 }],
    [IRIS, { x: PANEL_X + 10, y: posterY + 240, z: 900, ry: -16, rx: 16, rz: 0 }],
    [bf(102), { x: PANEL_X, y: posterY + 300, z: 500, ry: -10, rx: 20 }],
  ]);
  // 拆层时应用退到景深外、压暗一点，只留海报
  const sep = prog(g, LAYER_AT[0], LAYER_AT[5] + 12, easeOut);
  const appBlur = 7 * sep;
  const dim = 0.28 * sep;

  const panel = (
    <Panel kind="image" title="冬季 Jam 主视觉" meta="PNG · 2.4 MB" tabs={['PNG', 'PDF']} active="PNG">
      <ImageViewer w={POSTER_W} h={POSTER_H} label="PNG" size="2.4 MB" hide={explode > 0}>
        <Poster />
      </ImageViewer>
    </Panel>
  );

  return (
    <Stage cam={cam}>
      <Plane w={APP_W} h={APP_H} blur={appBlur} res={3}>
        <App g={g} panel={panel} panelW={PANEL_W * open} active={g >= PANEL_OPEN - 4 ? 'poster' : undefined} pressed={pressed} />
        <div style={{ position: 'absolute', inset: 0, borderRadius: 18, background: `oklch(0.25 0.02 55 / ${dim})` }} />
      </Plane>
      {explode > 0 &&
        POSTER_LAYERS.map((l) => (
          <Plane key={l} w={POSTER_W} h={POSTER_H} x={PANEL_X} y={posterY} z={2 + LAYER_Z[l] * explode * prog(g, LAYER_AT[POSTER_LAYERS.indexOf(l)], LAYER_AT[POSTER_LAYERS.indexOf(l)] + 12, easeLock)} scale={fit.fit} res={3}>
            <div style={{ filter: l === 'paper' ? `drop-shadow(0 ${30 * explode}px ${60 * explode}px oklch(0.2 0.02 50 / 0.35))` : undefined }}>
              <Poster only={l} />
            </div>
          </Plane>
        ))}
    </Stage>
  );
}

/** 同心弧扩开：一圈一圈落在八分音符上，最后一圈露出下一个镜头 */
const IRIS_COLORS = [DEEP, RUST, AMBER, OCHRE];
function IrisRings({ g }: { g: number }) {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {IRIS_COLORS.map((c, k) => {
        const p = prog(g, IRIS_AT[k], IRIS_AT[k] + 14, easeLock);
        if (p <= 0) return null;
        const r = p * 1250;
        return <div key={c} style={{ position: 'absolute', left: 960 - r, top: 620 - r, width: r * 2, height: r * 2, borderRadius: '50%', background: c }} />;
      })}
    </AbsoluteFill>
  );
}
/** 最后一圈分四下扩开，每下一个十六分音符 */
const irisClip = (g: number) => `circle(${(steps(g, REVEAL_AT, 6) / 4) * 1250}px at 960px 620px)`;

/* ---------------- 镜头 2：PPT ---------------- */

const PAGE_H = 720 * 900 / 1600;
/** 让第 k 页停在面板主体中间的滚动量 */
const scrollTo = (k: number) => Math.max(0, pageTop(k) + PAGE_H / 2 - (904 - 0) / 2);

function PptShot({ g }: { g: number }) {
  // 翻页：抬—停，每两拍一页
  const turn = steps(g, TURN_AT, 10);
  const s1 = Math.min(1, turn / 2);
  const s2 = Math.max(0, turn - 2) / 2;
  const scroll = lerp(lerp(scrollTo(0), scrollTo(1), s1), scrollTo(2), s2);
  const current = turn < 1 ? 1 : turn < 3 ? 2 : 3;
  // 柱子：从第 106 拍半开始，每个八分音符长一根
  const bars = BUDGET.map((_, i) => prog(g, BAR_AT[i], BAR_AT[i] + 10, easeLock));
  const total = BUDGET.reduce((a, b, i) => a + b.price * Math.min(1, bars[i]), 0);

  // 镜头盯着当前页的中心（第一页贴着顶，没法滚到中间）
  const pageCenter = (k: number) => wy(56 + pageTop(k) - scrollTo(k) + PAGE_H / 2);
  const bodyY = lerp(lerp(pageCenter(0), pageCenter(1), s1), pageCenter(2), s2);
  const whipOut = prog(g, WHIP_OUT, WHIP, easeIn);
  let cam = camPath(g, [
    [PPT_IN - 6, { x: PANEL_X, y: 10, z: 1000, ry: -8, rx: 5 }],
    [TURN_AT[0], { x: PANEL_X, y: 0, z: 1180, ry: -4, rx: 3 }],
    [BAR_AT[0], { x: PANEL_X - 10, y: 0, z: 1180, ry: 3, rx: 3 }],
    [BAR_AT[4], { x: PANEL_X + 40, y: -30, z: 1060, ry: 8, rx: 2 }],
    [WHIP_OUT, { x: PANEL_X + 250, y: -140, z: 760, ry: 12, rx: 2 }],
  ]);
  cam = { ...cam, y: cam.y + bodyY };
  cam = { ...cam, x: cam.x + whipOut * 900, ry: (cam.ry ?? 0) + whipOut * 28 };

  const panel = (
    <Panel kind="ppt" title="冬季 Jam 招新宣讲" meta="PPT · 8 页 · 3.1 MB" tabs={['PPT', 'PDF']} active="PPT">
      <PdfPages pages={[<SlideCover key="1" />, <SlideWhy key="2" />, <SlideBudget key="3" bars={bars} total={total} />, <SlideFlow key="4" />]} scroll={scroll} current={current} total={8} />
    </Panel>
  );
  return (
    <Stage cam={cam} filter={whipOut > 0.05 ? `blur(${whipOut * 14}px)` : undefined} punch={punch(g, [...TURN_AT, ...BAR_AT], 12)}>
      <Plane w={APP_W} h={APP_H} res={3}>
        <App g={g} panel={panel} panelW={PANEL_W} active="ppt" />
      </Plane>
    </Stage>
  );
}

/* ---------------- 镜头 3：Excel ---------------- */

const yuanPlain = (n: number) => n.toLocaleString('en-US');
export const BUDGET_ROWS: string[][] = [
  ['项目', '数量', '单价', '金额', '负责'],
  ['场地与安保', '1 场', '3,200', '3,200', '外联部'],
  ['音响与 DJ', '4 小时', '700', '2,800', '技术部'],
  ['灯光与舞台', '1 套', '2,150', '2,150', '技术部'],
  ['比赛奖品', '6 份', '280', '1,680', '赛事组'],
  ['物料印刷', '300 份', '3.8', '1,140', '宣传部'],
  ['摄影摄像', '2 机位', '480', '960', '宣传部'],
  ['饮用水与补给', '220 人', '2.5', '550', '后勤部'],
  ['合计', '', '', yuanPlain(BUDGET_TOTAL), ''],
  ['人均（240 人）', '', '', '52', ''],
];
const SURNAMES = '林陈王张李赵周吴徐孙胡朱高何郭马罗梁宋郑谢韩唐冯'.split('');
const GIVEN = ['一', '可', '子涵', '思远', '雨桐', '浩然', '嘉怡', '泽宇', '若曦', '明轩', '诗琪', '俊杰', '欣然', '天佑', '梓萱', '宇航'];
const COLLEGES = ['计算机学院', '外国语学院', '建筑工程学院', '经济学院', '医学院', '人文学院', '机械工程学院', '管理学院'];
const WANTS = ['Battle', 'Showcase', 'Open Cypher', '只是来看'];
const SIGNUPS: string[][] = [
  ['序号', '姓名', '学院', '想参加', '报名时间'],
  ...Array.from({ length: 40 }, (_, i) => [
    String(i + 1),
    SURNAMES[(i * 7) % SURNAMES.length] + GIVEN[(i * 5 + 3) % GIVEN.length],
    COLLEGES[(i * 3) % COLLEGES.length],
    WANTS[(i * 13) % 7 < 3 ? 0 : (i * 13) % 7 < 5 ? 1 : (i * 13) % 7 < 6 ? 2 : 3],
    `12-${String(13 + Math.floor(i / 9)).padStart(2, '0')} ${String(9 + ((i * 5) % 13)).padStart(2, '0')}:${String((i * 17) % 60).padStart(2, '0')}`,
  ]),
];

function SheetShot({ g }: { g: number }) {
  const whipIn = 1 - prog(g, WHIP, WHIP + 12, easeOut);
  const toNames = g >= SCROLL_AT[0] - 2;
  const rowIn = (i: number) => (toNames ? 1 : prog(g, ROW_AT[Math.min(ROW_AT.length - 1, Math.floor(i / 2))], ROW_AT[Math.min(ROW_AT.length - 1, Math.floor(i / 2))] + 10, easeLock));
  const mark = steps(g, MARK_AT, 7) / 3;
  const nameScroll = (steps(g, SCROLL_AT.slice(1), 6) / Math.max(1, SCROLL_AT.length - 1)) * 620;

  const bodyTop = 56 + 40;
  const totalRowY = wy(bodyTop + 29 + 8 * 27 + 13);
  let cam = camPath(g, [
    [WHIP, { x: PANEL_X - 40, y: wy(bodyTop + 180), z: 1150, ry: -10, rx: 4 }],
    [bf(115), { x: PANEL_X - 10, y: wy(bodyTop + 170), z: 1050, ry: -4, rx: 4 }],
    [bf(117), { x: PANEL_X + 40, y: totalRowY + 20, z: 700, ry: 4, rx: 8 }],
    [SCROLL_AT[0], { x: PANEL_X + 30, y: totalRowY + 40, z: 760, ry: 6, rx: 8 }],
    [HTML_IN, { x: PANEL_X, y: wy(bodyTop + 300), z: 1250, ry: 12, rx: 6 }],
  ]);
  cam = { ...cam, x: cam.x - whipIn * 900, ry: (cam.ry ?? 0) - whipIn * 28 };

  const panel = (
    <Panel kind="sheet" title="冬季 Jam 预算与报名" meta="Excel · 3 个工作表 · 48 KB">
      {toNames ? (
        <SheetGrid rows={SIGNUPS} numeric={[true, false, false, false, false]} total={187} cols={5} sheet="报名名单" sheets={['预算', '报名名单', '物料清单']} scroll={nameScroll} />
      ) : (
        <SheetGrid
          rows={BUDGET_ROWS}
          numeric={[false, false, true, true, false]}
          total={10}
          cols={5}
          sheet="预算"
          sheets={['预算', '报名名单', '物料清单']}
          rowIn={rowIn}
          cellStyle={(r, c) =>
            r === 8 && c === 3 && mark > 0
              ? { boxShadow: `inset 0 0 0 ${3 * mark}px var(--accent), 0 0 ${14 * punch(g, MARK_AT, 10)}px var(--accent)`, background: `color-mix(in oklch, var(--accent) ${16 * Math.min(1, mark)}%, transparent)`, fontWeight: 600 }
              : r === 8
                ? { fontWeight: 600 }
                : undefined
          }
        />
      )}
    </Panel>
  );
  return (
    <Stage cam={cam} filter={whipIn > 0.05 ? `blur(${whipIn * 14}px)` : undefined} punch={punch(g, [...MARK_AT, ...ROW_AT, ...SCROLL_AT], 10)}>
      <Plane w={APP_W} h={APP_H} res={3}>
        <App g={g} panel={panel} panelW={PANEL_W} active="sheet" />
      </Plane>
    </Stage>
  );
}

/* ---------------- 镜头 4：报名网页 ---------------- */

function HtmlShot({ g }: { g: number }) {
  // Landing 的 filled：0.4 以内按字数打花名（三个字），0.7 填学院，0.9 选 Battle
  const nameK = passed(g, NAME_AT) + 1;
  const filled = g >= BATTLE_AT ? 0.9 : g >= COLLEGE_AT ? 0.7 : (nameK / 3) * 0.4;
  const pressed = g >= PRESS && g < PRESS + 8 ? 1 - Math.abs(g - PRESS - 4) / 4 : 0;
  const done = g >= PRESS + 6 ? 1 : 0;
  const count = done ? 187 : 186;
  const phoneY = wy(56 + 40 + 20 + 380);

  const close: Cam = camPath(g, [
    [HTML_IN, { x: PANEL_X + 10, y: phoneY - 60, z: 1250, ry: -16, rx: 5, rz: 0.8 }],
    [COLLEGE_AT, { x: PANEL_X, y: phoneY + 40, z: 1120, ry: -8, rx: 4 }],
    [PRESS - 8, { x: PANEL_X, y: phoneY + 200, z: 900, ry: -2, rx: 3 }],
    [PULL_AT[0], { x: PANEL_X - 10, y: phoneY + 190, z: 960, ry: 0, rx: 3 }],
  ]);
  // 按完之后按手打的点一格一格往后拉（每格的步幅一样，最后停在全景）
  const far: Cam = { x: 90, y: 10, z: 2500, ry: 9, rx: 4, rz: -0.6 };
  const pull = steps(g, PULL_AT, 9) / PULL_AT.length;
  const mix = (a?: number, b?: number) => lerp(a ?? 0, b ?? 0, easeInOut(pull) * 0.35 + pull * 0.65);
  const cam: Cam = { x: mix(close.x, far.x), y: mix(close.y, far.y), z: mix(close.z, far.z), ry: mix(close.ry, far.ry), rx: mix(close.rx, far.rx), rz: mix(close.rz, far.rz) };

  const panel = (
    <Panel kind="html" title="报名页 · 冬季 Jam" meta="网页 · 38 KB">
      <HtmlPhone size="38 KB">
        <Landing filled={filled} pressed={pressed} count={count} done={done} />
      </HtmlPhone>
    </Panel>
  );
  return (
    <Stage cam={cam} punch={punch(g, [PRESS, ...NAME_AT, COLLEGE_AT, BATTLE_AT, ...PULL_AT], 12)}>
      <Plane w={APP_W} h={APP_H} res={3}>
        <App g={g} panel={panel} panelW={PANEL_W} active="html" />
      </Plane>
    </Stage>
  );
}

export function Make() {
  const g = useCurrentFrame() + MAKE_START;
  let body: ReactNode;
  if (g < PPT_IN - 4) {
    body = (
      <>
        <PosterShot g={g} />
        <IrisRings g={g} />
      </>
    );
  } else if (g < REVEAL_AT[3] + 6) {
    body = (
      <>
        <PosterShot g={g} />
        <IrisRings g={g} />
        <AbsoluteFill style={{ clipPath: irisClip(g) }}>
          <PptShot g={g} />
        </AbsoluteFill>
      </>
    );
  } else if (g < WHIP) body = <PptShot g={g} />;
  else if (g < HTML_IN) body = <SheetShot g={g} />;
  else body = <HtmlShot g={g} />;

  return (
    <AbsoluteFill>
      {body}
      <PaperLight />
      <Vignette strength={0.18} color="60,45,30" />
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
}
