import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { easeInOut, easeLock, FPS, prog } from '../lib/time';

/*
 * 歌词：只在四个和画面意思对得上的地方出现，一个词一个词跟着 JB 的嗓音落下。
 * 不是字幕——Fraunces 斜体小字，前面是品牌的两道竖线。
 */

type Word = [string, number]; // 词，成片秒（analysis/words2.py 的 whisper 词边界 + 人声分轨音头逐词对齐）
interface Line { words: Word[]; tone: 'ink' | 'paper'; pos: 'left' | 'right' | 'center'; hold?: number }

export const LYRICS: Line[] = [
  // 开始打字：别光想，动手
  { words: [['Get', 20.563], ['up', 20.698], ['offa', 20.932], ['that', 21.227], ['thing,', 21.546]], tone: 'ink', pos: 'right' },
  // 海报拆层的那一秒：压力卸掉
  { words: [['…release', 51.2], ['that', 51.673], ['pressure.', 51.917]], tone: 'ink', pos: 'left' },
  // 按下报名
  { words: [['Follow', 66.374], ['me.', 67.018]], tone: 'ink', pos: 'right' },
  // 结尾卡片：最后一声号召
  { words: [['Get', 82.12], ['up', 82.39], ['offa', 82.8], ['that', 83.1], ['thing.', 83.42]], tone: 'paper', pos: 'center', hold: 99 },
];

export function Lyrics() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {LYRICS.map((l, i) => {
        const f0 = Math.round(l.words[0][1] * FPS) - 2;
        const fLast = Math.round(l.words[l.words.length - 1][1] * FPS);
        const f1 = fLast + Math.round((l.hold ?? 1.3) * FPS);
        if (frame < f0 || frame > f1 + 20) return null;
        const out = prog(frame, f1, f1 + 18, easeInOut);
        const color = l.tone === 'ink' ? 'oklch(0.26 0.015 55)' : 'oklch(0.92 0.01 80)';
        const mark = prog(frame, f0, f0 + 10, easeLock);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              // 每句放在那一镜干净的一侧（左下是应用侧栏 / 海报深色底边的时候就放右下）
              ...(l.pos === 'left' ? { left: 110, bottom: 96 } : l.pos === 'right' ? { right: 110, bottom: 96 } : { left: 0, right: 0, top: 836, justifyContent: 'center' }),
              display: 'flex', alignItems: 'center', gap: 18, opacity: 1 - out, transform: `translateY(${-out * 8}px)`,
            }}
          >
            {l.pos !== 'center' && (
              <span style={{ display: 'flex', gap: 4, transform: `scaleY(${mark})` }}>
                <span style={{ width: 2.5, height: 30, borderRadius: 2, background: color, opacity: 0.8 }} />
                <span style={{ width: 2.5, height: 30, borderRadius: 2, background: 'var(--accent)' }} />
              </span>
            )}
            <span
              style={{
                fontFamily: 'var(--font-fraunces)', fontStyle: 'italic', fontSize: l.pos === 'center' ? 34 : 40, letterSpacing: '-0.005em', color,
                fontVariationSettings: '"SOFT" 100, "WONK" 1, "opsz" 72', display: 'flex', gap: '0.28em',
                textShadow: l.tone === 'ink' ? '0 0 14px oklch(0.97 0.012 80 / 0.95), 0 0 4px oklch(0.97 0.012 80 / 0.9)' : '0 0 24px oklch(0.8 0.1 60 / 0.25)',
              }}
            >
              {l.words.map(([w, t]) => {
                const f = Math.round(t * FPS);
                const p = prog(frame, f - 1, f + 9, easeLock);
                return (
                  <span key={w + t} style={{ display: 'inline-block', opacity: Math.min(1, p * 2), transform: `translateY(${(1 - p) * -16}px)`, filter: p < 1 ? `blur(${(1 - p) * 5}px)` : undefined }}>
                    {w}
                  </span>
                );
              })}
            </span>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}
