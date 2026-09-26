import data from '../taps.json';
import { FPS } from './time';

/*
 * 用户手打的点（tools/tap.html 录的，analysis/taps.py 吸附到了最近的真实音头上）。
 * 这是"哪一下要卡"的权威来源：比拍子密的地方，就是 locker 会卡的那些声音。
 */

const PTS = (data as number[][]).map(([t, b]) => ({ t, b, f: Math.round(t * FPS) }));

/** 时间区间 [s0, s1)（秒）里的用户点，返回帧号 */
export function pts(s0: number, s1: number): number[] {
  return PTS.filter((p) => p.t >= s0 && p.t < s1).map((p) => p.f);
}

/** 离某个时间（秒）最近的用户点的帧号 */
export function near(s: number): number {
  let best = PTS[0];
  for (const p of PTS) if (Math.abs(p.t - s) < Math.abs(best.t - s)) best = p;
  return best.f;
}

/** 不在拍子上的点（切分、接拍）：适合做镜头的"顿" */
export function offbeat(s0: number, s1: number): number[] {
  return PTS.filter((p) => p.t >= s0 && p.t < s1 && Math.abs(p.b - Math.round(p.b)) > 0.2).map((p) => p.f);
}
