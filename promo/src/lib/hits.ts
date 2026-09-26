import data from '../hits.json';
import { beat, easeLock, easeOut, FPS } from './time';

/*
 * 卡点：配乐分轨后的音头（analysis/hits.py 导出）。
 * 不只卡拍子——贝斯的切分、吉他 / 铜管的十六分音符快跑、JB 的喊声，都是 locker 会卡的点。
 */

export type Stem = 'bass' | 'drums' | 'other' | 'vocals';
export interface Hit { f: number; t: number; s: number; q: number; stem: Stem }

const ALL: Hit[] = (Object.keys(data) as Stem[])
  .flatMap((stem) => (data[stem] as number[][]).map(([t, s, q]) => ({ f: Math.round(t * FPS), t, s, q, stem })))
  .sort((a, b) => a.t - b.t);

/**
 * 拍号区间 [b0, b1) 里这些分轨的音头。同一个十六分音符上多个分轨一起响，只留一个（取最强、最早）。
 */
export function hits(stems: Stem[], b0: number, b1: number, min = 0.3): Hit[] {
  const byQ = new Map<number, Hit>();
  for (const h of ALL) {
    if (!stems.includes(h.stem) || h.q < b0 || h.q >= b1 || h.s < min) continue;
    const prev = byQ.get(h.q);
    if (!prev) byQ.set(h.q, { ...h });
    else byQ.set(h.q, { ...prev, s: Math.max(prev.s, h.s), f: Math.min(prev.f, h.f), t: Math.min(prev.t, h.t) });
  }
  return [...byQ.values()].sort((a, b) => a.t - b.t);
}

/**
 * 取 n 个点：优先最强的，彼此至少隔 gap 帧；不够的用十六分音符网格补上。按时间排序返回帧号。
 */
export function pick(list: Hit[], n: number, b0: number, b1: number, gap = 6): number[] {
  const chosen: number[] = [];
  for (const h of [...list].sort((a, b) => b.s - a.s)) {
    if (chosen.length >= n) break;
    if (chosen.every((f) => Math.abs(f - h.f) >= gap)) chosen.push(h.f);
  }
  // 补网格：从区间里的十六分音符里挑离已选点最远的
  const grid: number[] = [];
  for (let q = b0; q < b1; q += 0.25) grid.push(Math.round(beat(q) * FPS));
  while (chosen.length < n && grid.length) {
    let best = grid[0];
    let bestD = -1;
    for (const f of grid) {
      const d = Math.min(...chosen.map((c) => Math.abs(c - f)), 1e9);
      if (d > bestD) { bestD = d; best = f; }
    }
    chosen.push(best);
    grid.splice(grid.indexOf(best), 1);
  }
  return chosen.sort((a, b) => a - b);
}

/** 最近一个已经过去的点的序号（-1 表示还没到第一个） */
export function passed(frame: number, frames: number[]) {
  let k = -1;
  for (let i = 0; i < frames.length; i += 1) if (frame >= frames[i]) k = i;
  return k;
}

/** "顿一下"：快速顶起、停住、缓落，0–1。给镜头的微推 / 发光用 */
export function punch(frame: number, frames: number[], len = 12) {
  let v = 0;
  for (const f of frames) {
    const d = frame - f;
    if (d < 0 || d >= len) continue;
    const a = d < 2 ? easeOut(d / 2) : d < 4 ? 1 : 1 - easeOut((d - 4) / (len - 4));
    v = Math.max(v, a);
  }
  return v;
}

/** 分步推进：每到一个点往前走一格（带 easeLock 回弹），返回 0–n 的连续值 */
export function steps(frame: number, frames: number[], len = 8) {
  let v = 0;
  for (const f of frames) {
    const d = frame - f;
    if (d <= 0) continue;
    v += d >= len ? 1 : easeLock(d / len);
  }
  return v;
}
