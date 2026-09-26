import { Easing, interpolate } from 'remotion';
import beatmap from '../beatmap.json';

export const FPS = 60;
export const W = 1920;
export const H = 1080;

/** 剪好的配乐里的关键时刻（秒） */
export const MARKS = {
  total: beatmap.marks.total,
  cut: beatmap.marks.cut_film,
  stop: beatmap.marks.stop_film,
  hit: beatmap.marks.hit_film,
};
export const DURATION = Math.ceil(MARKS.total * FPS);

/*
 * 拍点：原始跟踪结果在摇摆的踩镲上会抖 ±40ms，按段落做线性拟合得到平滑拍网格。
 * 段落：前奏 0–31 拍，主律动 32 拍起到剪辑点，剪辑点之后到停顿。
 */
const raw = beatmap.beats.map((b) => b.t);
function fit(i0: number, i1: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = i0; i <= i1; i += 1) {
    xs.push(i);
    ys.push(raw[i]);
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k += 1) {
    num += (xs[k] - mx) * (ys[k] - my);
    den += (xs[k] - mx) ** 2;
  }
  const slope = num / den;
  return { i0, i1, slope, at: (i: number) => my + slope * (i - mx) };
}
const cutIndex = raw.findIndex((t) => t >= MARKS.cut - 0.05);
const SEGMENTS = [fit(0, 31), fit(32, cutIndex - 1), fit(cutIndex, raw.length - 1)];

/** 第 i 拍（从 0 开始，第 0 拍 = 音乐进来的第一下）的时间，秒 */
export function beat(i: number): number {
  const seg = SEGMENTS.find((s) => i <= s.i1) ?? SEGMENTS[SEGMENTS.length - 1];
  return seg.at(i);
}
/** 第 i 拍所在的帧 */
export const bf = (i: number) => Math.round(beat(i) * FPS);
export const sf = (sec: number) => Math.round(sec * FPS);
export const BEAT_COUNT = raw.length;
export const CUT_BEAT = cutIndex;
/** 拍长（秒），按段落 */
export const beatLen = (i: number) => (SEGMENTS.find((s) => i <= s.i1) ?? SEGMENTS[2]).slope;

/* ---------------- 缓动 ---------------- */

/** 产品里的 --ease-lock：快速抵达、轻微回弹后立刻定住 */
export const easeLock = Easing.bezier(0.2, 1.25, 0.32, 1);
export const easeOut = Easing.bezier(0.22, 1, 0.36, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.55, 0, 0.9, 0.3);
/** 镜头：慢起、长滑、轻落 */
export const easeCam = Easing.bezier(0.45, 0, 0.15, 1);

/** frame 在 [a, b] 之间的进度（0–1，两端夹住），可带缓动 */
export function prog(frame: number, a: number, b: number, ease: (t: number) => number = (t) => t) {
  return ease(interpolate(frame, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
}

/** 在 frame 处从 from 到 to（帧），带缓动的插值 */
export function tween(frame: number, a: number, b: number, from: number, to: number, ease = easeOut) {
  return from + (to - from) * prog(frame, a, b, ease);
}

/**
 * "抬—停—落—停"：锁梁 / 双竖线的招牌节奏。给定一拍开始的帧和拍长，返回 0（落下）–1（抬起）。
 * 前 18% 快速抬起、停到 42%，再快速落下（带回弹）、停住。
 */
export function liftStop(frame: number, start: number, len: number) {
  const t = (frame - start) / len;
  if (t < 0 || t >= 1) return 0;
  if (t < 0.18) return easeOut(t / 0.18);
  if (t < 0.42) return 1;
  if (t < 0.58) return 1 - easeLock((t - 0.42) / 0.16);
  return 0;
}

/** 确定性伪随机（给颗粒、打字节奏等用） */
export function rand(seed: number) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
