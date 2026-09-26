import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CinematicLock } from '../art/CinematicLock';
import { AppFrame, APP_H, APP_W, COL_MAX, SIDEBAR_W } from '../ui/app';
import {
  Composer, lockIn, rise, SearchRow, SourceCard, StarterChips, StatusRow, ThinkingChip, UserBubble, type Source,
} from '../ui/kit';
import { Camera, Grain, PaperLight, Plane, Vignette, lerp } from '../lib/stage';
import { beat, bf, easeCam, easeIn, easeInOut, easeLock, easeOut, FPS, liftStop, prog, tween } from '../lib/time';
import { hits, passed, pick, punch } from '../lib/hits';

/*
 * 提问与理解（19.5 – 31.8s）
 * 白场里是一道巨大的琥珀色光标（上一个镜头锁孔里的那道线），镜头拉开，是 LockAI 的空状态。
 * 按八分音符打字，重音上发送；输入框落到底部，思考竖线跟着拍子起伏，联网搜索的来源从界面里浮出来。
 */

export const ASK_START = bf(32) - 1;
export const ASK_END = bf(56) + 4;

export const PROMPT_CHUNKS = ['帮我', '办一场', ' Funk&Love', ' 冬季', ' Jam：', '主视觉', '海报、', '预算表、', '宣讲', ' PPT，', '再做', '一个', '报名', '网页。'];
export const PROMPT = PROMPT_CHUNKS.join('');
export const SESSION_TITLE = '冬季 Jam 整套物料';

const SOURCES: Source[] = [
  { title: '学生活动中心 · 场地借用须知', site: 'zju.edu.cn', letter: 'Z', tint: 'oklch(0.45 0.12 255)' },
  { title: '高校街舞赛事预算复盘', site: 'zhihu.com', letter: '知', tint: 'oklch(0.55 0.16 250)' },
  { title: '小型现场音响租赁报价', site: 'xiaohongshu.com', letter: '小', tint: 'oklch(0.6 0.2 22)' },
  { title: 'Jam 活动流程怎么排', site: 'bilibili.com', letter: 'B', tint: 'oklch(0.68 0.15 350)' },
];

/** 打字：每一块落在一个切分音头上（贝斯、吉他 / 铜管、人声），而不是均匀的八分音符 */
const TYPE_AT = pick(hits(['bass', 'other', 'vocals'], 36, 43.9), PROMPT_CHUNKS.length, 36, 43.9, 7);
/** 思考竖线：一道跟贝斯，一道跟吉他 / 铜管 */
const BASS_HITS = hits(['bass'], 44, 56, 0.45).map((h) => h.f);
const OTHER_HITS = hits(['other'], 44, 56, 0.45).map((h) => h.f);
/** 来源卡片一张一张弹在音头上 */
const CARD_AT = pick(hits(['bass', 'other', 'vocals'], 49.5, 51.5), 4, 49.5, 51.5, 10);
/** 回答正文：一阵一阵地出来，每阵落在一个音头上 */
const STREAM_AT = hits(['bass', 'other', 'vocals'], 53.25, 56, 0.35).map((h) => h.f);

const ANSWER = '好，我把这件事拆成四块：主视觉、预算、宣讲和报名页。它们要共用同一套配色、文案和数据，我先把规范定下来，再分头去做，最后逐个检查。';

/** 空状态里各元素在对话栏里的位置（对话栏内坐标，头部以下） */
const HERO_TOP = 150;

/** 浅色场景的背景：比界面暗一档的暖灰，界面才「立」得起来 */
export const BACKDROP = 'oklch(0.83 0.016 68)';
export const BACKDROP_GLOW = 'radial-gradient(ellipse 65% 60% at 45% 38%, oklch(0.93 0.012 78), oklch(0.84 0.016 70) 60%, oklch(0.72 0.02 60))';
const COMPOSER_TOP = 420;
const DOCK_TOP = 904 - 134 - 22 - 12 - 8;

export function Ask() {
  const local = useCurrentFrame();
  const g = local + ASK_START;

  // 打字：从第 36 拍开始，每个八分音符一块
  const typeAt = (k: number) => TYPE_AT[k];
  let typed = '';
  PROMPT_CHUNKS.forEach((c, k) => { if (g >= typeAt(k)) typed += c; });
  const send = bf(44);
  const sent = g >= send + 4;
  const flip = prog(g, send + 4, send + 4 + 36, easeInOut);

  // 光标：拍子上亮、反拍上灭（发送前）
  const beatIdx = Math.floor(((g / FPS) - beat(32)) / (beat(33) - beat(32)) * 2);
  const caretOn = g < typeAt(0) ? beatIdx % 2 === 0 || g < bf(33) : g < typeAt(PROMPT_CHUNKS.length - 1) + 20 || beatIdx % 2 === 0;

  // 镜头：从光标特写拉开 → 慢慢推向输入框 → 发送后跟到消息区
  const caretX = SIDEBAR_W + (1328 - COL_MAX) / 2 + 20 - APP_W / 2;
  const caretY = 56 + COMPOSER_TOP + 30 - APP_H / 2;
  const pullOut = prog(g, bf(32), bf(34) + 20, (x) => 1 - Math.pow(1 - x, 4));
  const pushIn = prog(g, bf(34) + 20, send, easeInOut);
  const follow = prog(g, send + 4, bf(47), easeCam);
  const drift = prog(g, bf(47), bf(56), easeInOut);
  let cam = {
    x: lerp(caretX, 40, pullOut), y: lerp(caretY, 10, pullOut), z: lerp(90, 2450, pullOut),
    rx: lerp(0, 9, pullOut), ry: lerp(0, -16, pullOut), rz: lerp(0, -1.2, pullOut), persp: 2200,
  };
  cam = { ...cam, x: lerp(cam.x, 150, pushIn), y: lerp(cam.y, 55, pushIn), z: lerp(cam.z, 1080, pushIn), ry: lerp(cam.ry, -6, pushIn), rx: lerp(cam.rx, 5, pushIn), rz: lerp(cam.rz, 0, pushIn) };
  cam = { ...cam, x: lerp(cam.x, 150, follow), y: lerp(cam.y, -300, follow), z: lerp(cam.z, 1020, follow), ry: lerp(cam.ry, 8, follow), rx: lerp(cam.rx, 6, follow) };
  cam = { ...cam, x: lerp(cam.x, 160, drift), y: lerp(cam.y, -265, drift), z: lerp(cam.z, 900, drift), ry: lerp(cam.ry, 13, drift) };

  // 来源卡片浮出 → 对焦到卡片 → 收回
  const cardsOut = prog(g, CARD_AT[0], CARD_AT[3] + 10, easeOut);
  const cardsBack = prog(g, bf(53) - 10, bf(53) + 14, easeInOut);
  const cardsVis = cardsOut * (1 - cardsBack);
  const planeBlur = 3.2 * cardsVis;

  // 思考竖线：两道细线各跟一件乐器，"抬—停—落—停"
  const bar = (list: number[]) => 0.4 + 0.6 * punch(g, list, 14);
  const barPhase = (d: number) => (d === 0 ? bar(BASS_HITS) : bar(OTHER_HITS));

  const thinkStart = send + 30;
  const thinkDone = bf(53);
  const thinkSeconds = g < thinkDone ? Math.max(0, (g - thinkStart) / FPS) * 1.45 : 18;
  const searchStart = bf(47);
  const searchDone = bf(49);

  // 回答正文：每个音头推出一小段（带 3 帧的铺开）
  const streamStart = bf(53) + 12;
  const per = Math.ceil(ANSWER.length / Math.max(1, STREAM_AT.length));
  let chars = 0;
  STREAM_AT.forEach((f) => { if (g >= f) chars += Math.min(per, Math.ceil(per * (g - f + 1) / 3)); });
  chars = Math.min(ANSWER.length, chars);
  const shown = ANSWER.slice(0, chars);

  // 白场 → 光标：第一拍上白色迅速褪去
  const flash = 1 - prog(g, bf(32), bf(32) + 16, easeOut);

  const composerTop = sent ? lerp(COMPOSER_TOP, DOCK_TOP, flip) : COMPOSER_TOP;
  const heroFade = 1 - prog(g, send + 2, send + 16, easeOut);
  const newSession = sent ? { title: SESSION_TITLE, active: true, running: true } : null;
  const sessionIn = prog(g, send + 10, send + 30, easeLock);

  return (
    <AbsoluteFill style={{ background: BACKDROP }}>
      <AbsoluteFill style={{ background: BACKDROP_GLOW }} />
      <Camera cam={cam}>
        {/* 地面上的一点投影，让屏幕"立"在空间里 */}
        <Plane w={APP_W * 1.1} h={260} y={APP_H / 2 + 40} rx={90} z={-10} opacity={0.5 * pullOut}>
          <div style={{ width: '100%', height: '100%', background: 'radial-gradient(ellipse 50% 50% at 50% 50%, oklch(0.4 0.02 60 / 0.35), transparent 70%)' }} />
        </Plane>
        <Plane w={APP_W} h={APP_H} blur={planeBlur} res={3}>
          <AppFrame frame={g} title={sent ? SESSION_TITLE : undefined} busy={sent} newSession={newSession && sessionIn > 0 ? newSession : null}>
            {/* 空状态 */}
            {heroFade > 0 && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: HERO_TOP, opacity: heroFade, transform: `translateY(${-(1 - heroFade) * 30}px)` }}>
                <div className="mx-auto mb-7 flex w-full max-w-[46rem] flex-col items-center text-center">
                  <div className="mb-3" style={{ width: 150, height: 150 }}>
                    <Orb g={g} />
                  </div>
                  <h1 className="min-h-[1.3em] font-serif text-[32px] font-medium leading-tight tracking-tight text-fg">晚上好，Funk&amp;Love</h1>
                  <p className="mt-2 text-[14.5px] text-fg-faint">今天想聊点什么？</p>
                </div>
              </div>
            )}
            {heroFade > 0 && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: COMPOSER_TOP + 150, opacity: heroFade }}>
                <StarterChips />
              </div>
            )}

            {/* 对话 */}
            {sent && (
              <div className="absolute inset-x-0 top-0 mx-auto w-full max-w-[46rem] px-6 pt-4" style={{ left: 0, right: 0 }}>
                <UserBubble text={PROMPT} style={lockIn(prog(g, send + 8, send + 30))} />
                <div className="mt-6">
                  {g >= thinkStart && (
                    <div style={rise(prog(g, thinkStart, thinkStart + 24))}>
                      <ThinkingChip live={g < thinkDone} seconds={thinkSeconds} tokens="3.2k" frame={g} bars={[barPhase(0), barPhase(8)]} />
                    </div>
                  )}
                  {g >= searchStart && (
                    <div style={rise(prog(g, searchStart, searchStart + 24))}>
                      <SearchRow
                        state={g < searchDone ? 'running' : 'done'}
                        label="搜索了"
                        query={g < searchDone ? '杭州高校 冬季街舞 Jam 场地与预算' : '3 次'}
                        count="12 个来源"
                        seconds={g < searchDone ? (g - searchStart) / FPS * 2 : 6}
                        sources={SOURCES}
                        frame={g}
                      />
                    </div>
                  )}
                  {g >= streamStart && (
                    <div className="md" style={{ marginTop: 8 }}>
                      <p>
                        {shown}
                        <span style={{ opacity: 0.35 }}>{ANSWER.slice(chars, chars + 3)}</span>
                      </p>
                    </div>
                  )}
                  {g >= bf(55) && <StatusRow label="正在组织工作" frame={g} seconds={(g - bf(55)) / FPS} className="mt-1" />}
                </div>
              </div>
            )}

            {/* 输入框 */}
            <div style={{ position: 'absolute', left: 0, right: 0, top: composerTop }}>
              <div className="relative mx-auto w-full max-w-[46rem]">
                <Composer
                  variant={sent && flip > 0.5 ? 'dock' : 'hero'}
                  text={sent ? '' : typed}
                  caret={!sent && caretOn}
                  sendState={sent ? 'stop' : typed ? 'send' : 'mic'}
                  pressed={g >= send && g < send + 8 ? 1 - Math.abs(g - send - 4) / 4 : 0}
                />
              </div>
            </div>
          </AppFrame>
        </Plane>

        {/* 浮出来的来源 */}
        {cardsVis > 0.001 &&
          SOURCES.map((s, i) => {
            const p = prog(g, CARD_AT[i], CARD_AT[i] + 16, easeLock) * (1 - cardsBack);
            const spot = [[-40, -420], [290, -425], [10, -290], [300, -315]][i];
            const baseX = spot[0];
            return (
              <Plane
                key={s.site}
                w={300}
                h={64}
                x={lerp(60, baseX, p)}
                y={lerp(-250, spot[1], p)}
                z={lerp(0, 200 + (i % 2) * 70, p)}
                ry={lerp(0, -12, p)}
                rx={lerp(0, -4, p)}
                opacity={Math.min(1, p * 1.5)}
                res={4}
              >
                <div className="light" style={{ fontFamily: 'var(--font-sans)', filter: 'drop-shadow(0 18px 30px oklch(0.3 0.02 50 / 0.25))' }}>
                  <SourceCard s={s} i={i + 1} />
                </div>
              </Plane>
            );
          })}
      </Camera>
      <PaperLight />
      <Vignette strength={0.16} color="60,45,30" />
      <Grain opacity={0.05} />
      <AbsoluteFill style={{ background: 'oklch(0.97 0.012 80)', opacity: flash }} />
    </AbsoluteFill>
  );
}

/** 空状态里的锁（产品里是 WebGL 画的浅色锁），发送时扣一下 */
function Orb({ g }: { g: number }) {
  const send = bf(44);
  const snap = prog(g, send, send + 8, easeIn) * (1 - prog(g, send + 10, send + 40, easeOut));
  return (
    <CinematicLock
      width={150}
      height={150}
      scale={4}
      state={{
        cam: { pos: [1.2, 0.35, 4.3], target: [0, -0.12, 0], fov: 2.0 },
        lift: 0.28 * (1 - snap),
        sweep: 0.3 + Math.sin(g / 90) * 0.1,
        key: 1.1,
        rim: 0.4,
        glowL: 0,
        glowR: 0.35,
        bodyLight: 1,
        ambient: 0.55,
        clear: true,
        time: g,
      }}
    />
  );
}

