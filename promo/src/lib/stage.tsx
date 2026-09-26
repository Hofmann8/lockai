import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { rand } from './time';

/*
 * 空间感：所有界面都是摆在 3D 空间里的平面，镜头用 CSS perspective + 世界坐标的反向变换来"拍"。
 * 景深：离对焦平面越远，模糊越大（CSS filter blur），只给少数层用，控制渲染开销。
 */

export interface Cam {
  /** 镜头位置（px，世界坐标；z 越大越靠近观众） */
  x: number;
  y: number;
  z: number;
  /** 俯仰 / 偏航 / 滚转（度） */
  rx?: number;
  ry?: number;
  rz?: number;
  /** 透视距离（px），越小越广角 */
  persp?: number;
}

/** 镜头：children 里的内容按世界坐标摆放，(0,0,0) 在画面中心 */
export function Camera({ cam, children, style }: { cam: Cam; children: ReactNode; style?: CSSProperties }) {
  const persp = cam.persp ?? 2200;
  // 镜头往 +z 走 = 世界往 -z 退；视点固定在 perspective 处
  const world = `translateZ(${persp - cam.z}px) rotateX(${-(cam.rx ?? 0)}deg) rotateY(${-(cam.ry ?? 0)}deg) rotateZ(${-(cam.rz ?? 0)}deg) translate3d(${-cam.x}px, ${-cam.y}px, 0px)`;
  return (
    <AbsoluteFill style={{ perspective: persp, perspectiveOrigin: '50% 50%', overflow: 'hidden', ...style }}>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 0, height: 0, transformStyle: 'preserve-3d', transform: world }}>
        {children}
      </div>
    </AbsoluteFill>
  );
}

/** 摆在空间里的一块平面：中心放在 (x,y,z)，可以转角度 */
export function Plane({
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, scale = 1, w, h, blur = 0, opacity = 1, children, style, res = 1,
}: {
  x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; scale?: number;
  w: number; h: number; blur?: number; opacity?: number; children: ReactNode; style?: CSSProperties;
  /** 超采样：内容按 res 倍排版、再缩回来，镜头推近时字不糊 */
  res?: number;
}) {
  if (res !== 1) {
    return (
      <Plane x={x} y={y} z={z} rx={rx} ry={ry} rz={rz} scale={scale / res} w={w * res} h={h * res} blur={blur * res} opacity={opacity} style={style}>
        <div style={{ zoom: res, width: w, height: h }}>{children}</div>
      </Plane>
    );
  }
  return (
    <div
      style={{
        position: 'absolute',
        left: -w / 2,
        top: -h / 2,
        width: w,
        height: h,
        transformStyle: 'preserve-3d',
        transform: `translate3d(${x}px, ${y}px, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(${scale})`,
        // 很小的模糊不加：filter 会让 Chrome 按 1× 栅格化这一层，镜头一推近字就糊了
        filter: blur > 0.6 ? `blur(${blur.toFixed(2)}px)` : undefined,
        opacity,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** 景深：给定层到镜头的距离和对焦距离，算模糊半径 */
export function dof(layerDist: number, focusDist: number, aperture = 0.012) {
  return Math.min(22, Math.abs(layerDist - focusDist) * aperture);
}

/** 胶片颗粒：每帧换一次种子的 SVG 噪声，叠加模式很轻 */
export function Grain({ opacity = 0.07 }: { opacity?: number }) {
  const frame = useCurrentFrame();
  const seed = Math.floor(rand(frame) * 1000);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'overlay', opacity }}>
      <svg width="100%" height="100%">
        <filter id={`grain-${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
      </svg>
    </AbsoluteFill>
  );
}

/** 暗角 */
export function Vignette({ strength = 0.45, color = '0,0,0' }: { strength?: number; color?: string }) {
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        background: `radial-gradient(ellipse 75% 70% at 50% 50%, rgba(${color},0) 55%, rgba(${color},${strength}) 100%)`,
      }}
    />
  );
}

/** 整片画面的一层"光"：柔和的顶光渐变，让纸面有体积感 */
export function PaperLight({ opacity = 1 }: { opacity?: number }) {
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        opacity,
        background:
          'radial-gradient(ellipse 60% 55% at 38% 18%, oklch(1 0.01 80 / 0.55), transparent 70%), radial-gradient(ellipse 80% 60% at 70% 110%, oklch(0.55 0.03 60 / 0.10), transparent 70%)',
        mixBlendMode: 'soft-light',
      }}
    />
  );
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 镜头路径：关键帧之间用 Catmull-Rom 平滑穿过，速度连续（不会每个关键帧都停一下）。
 * 两端的段落自动缓入 / 缓出。
 */
export function camPath(frame: number, keys: [number, Cam][]): Cam {
  if (frame <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (frame >= last[0]) return last[1];
  let i = 0;
  while (i < keys.length - 2 && frame >= keys[i + 1][0]) i += 1;
  const [f1, c1] = keys[i];
  const [f2, c2] = keys[i + 1];
  const c0 = keys[i - 1]?.[1] ?? c1;
  const c3 = keys[i + 2]?.[1] ?? c2;
  let t = (frame - f1) / (f2 - f1);
  // 首尾两段缓入缓出（端点速度为 0，接缝处速度与样条一致）
  if (keys.length === 2) t = t * t * (3 - 2 * t);
  else if (i === 0) t = t * t * (2 - t);
  else if (i === keys.length - 2) { const u = 1 - t; t = 1 - u * u * (2 - u); }
  const cr = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const k = (key: keyof Cam, def: number) => cr(c0[key] ?? def, c1[key] ?? def, c2[key] ?? def, c3[key] ?? def);
  return { x: k('x', 0), y: k('y', 0), z: k('z', 2200), rx: k('rx', 0), ry: k('ry', 0), rz: k('rz', 0), persp: k('persp', 2200) };
}

/** 世界坐标里一个点到镜头的深度（沿视线方向），景深用 */
export function depthOf(cam: Cam, p: [number, number, number]) {
  const rad = Math.PI / 180;
  const a = -(cam.rx ?? 0) * rad;
  const b = -(cam.ry ?? 0) * rad;
  const c = -(cam.rz ?? 0) * rad;
  const x = p[0] - cam.x;
  const y = p[1] - cam.y;
  const x1 = x * Math.cos(c) - y * Math.sin(c);
  const y1 = x * Math.sin(c) + y * Math.cos(c);
  const z2 = -x1 * Math.sin(b) + p[2] * Math.cos(b);
  const z3 = y1 * Math.sin(a) + z2 * Math.cos(a);
  return cam.z - z3;
}
