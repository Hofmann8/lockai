'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/cn';
import { LockMark } from './LockMark';

/*
 * 一把用光线步进（SDF raymarching）画出来的 3D 锁，只有一个片元着色器，不依赖 three.js。
 * - 鼠标移动时轻微朝向光标
 * - 点击 / 外部触发时：锁梁抬起 → 绕左梁转一圈（腕花）→ 猛地扣下（锁）→ 停住 → 慢慢松开
 * - 离开视口、标签页隐藏、系统开启"减少动态效果"时停止渲染
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uTilt;
uniform float uLift;
uniform float uRoll;
uniform vec3 uBody;
uniform vec3 uMetal;
uniform vec3 uAccent;
uniform vec3 uGroove;
uniform float uDark;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdCappedTorus(vec3 p, vec2 sc, float ra, float rb) {
  p.x = abs(p.x);
  float k = (sc.y * p.x > sc.x * p.y) ? dot(p.xy, sc) : length(p.xy);
  return sqrt(dot(p, p) + ra * ra - 2.0 * ra * k) - rb;
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

const float LEG = 0.34;
const float TUBE = 0.074;

vec2 map(vec3 p) {
  // 锁身
  vec3 pb = p - vec3(0.0, -0.36, 0.0);
  float bodyRaw = sdRoundBox(pb, vec3(0.6, 0.46, 0.25), 0.17);
  // 锁孔换成两道竖槽
  float slotL = sdRoundBox(pb - vec3(-0.065, -0.02, 0.25), vec3(0.026, 0.14, 0.06), 0.02);
  float slotR = sdRoundBox(pb - vec3(0.065, -0.02, 0.25), vec3(0.026, 0.14, 0.06), 0.02);
  float slots = min(slotL, slotR);
  float body = max(bodyRaw, -slots);

  // 锁梁：绕左梁的竖轴转（腕花），整体按 uLift 抬起
  float lift = 0.3 * uLift;
  vec3 ps = p;
  ps.x += LEG;
  ps.xz = rot(uRoll) * ps.xz;
  ps.x -= LEG;
  ps.y -= lift;
  float arc = sdCappedTorus(ps - vec3(0.0, 0.08, 0.0), vec2(1.0, 0.0), LEG, TUBE);
  float legL = sdCapsule(ps, vec3(-LEG, 0.08, 0.0), vec3(-LEG, -0.22, 0.0), TUBE);
  float rightBottom = -0.22 + 0.18 * uLift;
  float legR = sdCapsule(ps, vec3(LEG, 0.08, 0.0), vec3(LEG, rightBottom, 0.0), TUBE);
  float shackle = min(arc, min(legL, legR));

  vec2 res = vec2(body, -slots > bodyRaw ? 3.0 : 1.0);
  if (shackle < res.x) res = vec2(shackle, 2.0);
  return res;
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0015, -0.0015);
  return normalize(
    e.xyy * map(p + e.xyy).x +
    e.yyx * map(p + e.yyx).x +
    e.yxy * map(p + e.yxy).x +
    e.xxx * map(p + e.xxx).x);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.02 + 0.09 * float(i);
    occ += (h - map(p + h * n).x) * sca;
    sca *= 0.8;
  }
  return clamp(1.0 - 2.2 * occ, 0.0, 1.0);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  // 机位拉远一点，锁梁抬到最高、身体转开时也不出画
  vec3 ro = vec3(0.0, -0.04, 4.6);
  vec3 rd = normalize(vec3(uv * 0.92, -2.2));

  float sway = sin(uTime * 0.6) * 0.05;
  mat2 yaw = rot(uTilt.x + sway + 0.32);
  mat2 pitch = rot(uTilt.y - 0.12);

  float t = 0.0;
  vec2 hit = vec2(-1.0);
  for (int i = 0; i < 90; i++) {
    vec3 p = ro + rd * t;
    p.xz = yaw * p.xz;
    p.yz = pitch * p.yz;
    vec2 d = map(p);
    if (d.x < 0.0008) { hit = vec2(t, d.y); break; }
    t += d.x * 0.9;
    if (t > 8.0) break;
  }

  if (hit.x < 0.0) { gl_FragColor = vec4(0.0); return; }

  vec3 p = ro + rd * hit.x;
  p.xz = yaw * p.xz;
  p.yz = pitch * p.yz;
  vec3 n = calcNormal(p);
  vec3 v = rd;
  v.xz = yaw * v.xz;
  v.yz = pitch * v.yz;

  vec3 key = normalize(vec3(-0.55, 0.85, 0.7));
  vec3 fill = normalize(vec3(0.8, -0.1, 0.5));
  float wrapKey = pow(clamp(dot(n, key) * 0.5 + 0.5, 0.0, 1.0), 2.0);
  float fillL = clamp(dot(n, fill), 0.0, 1.0);
  float ao = calcAO(p, n);
  float fres = pow(1.0 - clamp(dot(n, -v), 0.0, 1.0), 3.0);
  vec3 refl = reflect(v, n);
  float spec = pow(clamp(dot(refl, key), 0.0, 1.0), hit.y == 2.0 ? 42.0 : 14.0);

  vec3 base = hit.y == 2.0 ? uMetal : (hit.y == 3.0 ? uGroove : uBody);
  vec3 col = base * (0.28 + 0.78 * wrapKey) * mix(0.55, 1.0, ao);
  col += base * fillL * 0.12;
  col += spec * (hit.y == 2.0 ? 0.55 : 0.16) * mix(vec3(1.0), uAccent, 0.25);
  col += uAccent * fres * (0.22 + 0.2 * uDark);
  if (hit.y == 3.0) col = mix(col, uAccent, 0.35 * step(0.0, p.x));

  col = pow(col, vec3(0.94));
  gl_FragColor = vec4(col, 1.0);
}
`;

const PALETTES = {
  light: { body: [0.94, 0.925, 0.9], metal: [0.74, 0.72, 0.69], groove: [0.36, 0.33, 0.3], accent: [0.93, 0.5, 0.22] },
  dark: { body: [0.27, 0.255, 0.24], metal: [0.62, 0.6, 0.57], groove: [0.1, 0.095, 0.09], accent: [0.98, 0.62, 0.3] },
} as const;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('[LockOrb] shader', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

interface LockOrbProps {
  size: number;
  className?: string;
  /** 每次变化触发一次"腕花 + 扣锁" */
  trigger?: number;
  /** 是否跟随整页的鼠标（登录页开，聊天空状态关只跟随自身区域） */
  followWindow?: boolean;
}

export function LockOrb({ size, className, trigger, followWindow = false }: LockOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const [failed, setFailed] = useState(false);
  const state = useRef({ lift: 0.28, roll: 0, tiltX: 0, tiltY: 0, targetX: 0, targetY: 0 });
  const dirty = useRef(true);
  const busy = useRef(false);
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;

  const play = useCallback(() => {
    if (busy.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    busy.current = true;
    const s = state.current;
    gsap.timeline({ onUpdate: () => { dirty.current = true; }, onComplete: () => { busy.current = false; } })
      .to(s, { lift: 1, duration: 0.2, ease: 'power3.out' })
      .to(s, { roll: `+=${Math.PI * 2}`, duration: 0.62, ease: 'power2.inOut' })
      .to(s, { lift: 0, duration: 0.11, ease: 'back.out(2.6)' })
      .to(s, { lift: 0, duration: 0.5 })
      .to(s, { lift: 0.28, duration: 0.9, ease: 'power2.inOut' })
      .set(s, { roll: 0 });
  }, []);

  useEffect(() => {
    if (trigger === undefined || trigger === 0) return;
    play();
  }, [trigger, play]);

  useEffect(() => {
    dirty.current = true;
  }, [resolvedTheme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: false });
    if (!gl) {
      setFailed(true);
      return;
    }
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      setFailed(true);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFailed(true);
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uni = {
      res: u('uRes'), time: u('uTime'), tilt: u('uTilt'), lift: u('uLift'), roll: u('uRoll'),
      body: u('uBody'), metal: u('uMetal'), accent: u('uAccent'), groove: u('uGroove'), dark: u('uDark'),
    };

    const dpr = Math.min(2, (window.devicePixelRatio || 1) * 1.5);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let visible = true;
    const start = performance.now();

    const draw = (now: number) => {
      const s = state.current;
      s.tiltX += (s.targetX - s.tiltX) * 0.08;
      s.tiltY += (s.targetY - s.tiltY) * 0.08;
      const palette = PALETTES[themeRef.current === 'dark' ? 'dark' : 'light'];
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uni.res, canvas.width, canvas.height);
      gl.uniform1f(uni.time, reduce ? 0 : (now - start) / 1000);
      gl.uniform2f(uni.tilt, s.tiltX, s.tiltY);
      gl.uniform1f(uni.lift, s.lift);
      gl.uniform1f(uni.roll, s.roll);
      gl.uniform3fv(uni.body, palette.body);
      gl.uniform3fv(uni.metal, palette.metal);
      gl.uniform3fv(uni.accent, palette.accent);
      gl.uniform3fv(uni.groove, palette.groove);
      gl.uniform1f(uni.dark, themeRef.current === 'dark' ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const frame = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      draw(now);
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (reduce) {
        draw(performance.now());
        return;
      }
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
    };

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) kick();
    });
    observer.observe(canvas);

    const onMove = (event: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const span = followWindow ? Math.max(window.innerWidth, window.innerHeight) / 2 : r.width * 2.2;
      state.current.targetX = Math.max(-1, Math.min(1, (event.clientX - cx) / span)) * 0.55;
      state.current.targetY = Math.max(-1, Math.min(1, (event.clientY - cy) / span)) * 0.35;
      dirty.current = true;
    };
    const onVisibility = () => kick();
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    kick();

    // 减少动态效果时只在状态变化后补一帧
    const idleTimer = reduce
      ? window.setInterval(() => {
          if (dirty.current) {
            dirty.current = false;
            draw(performance.now());
          }
        }, 120)
      : 0;

    return () => {
      cancelAnimationFrame(raf);
      if (idleTimer) window.clearInterval(idleTimer);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [size, followWindow]);

  if (failed) {
    return (
      <div className={cn('flex items-center justify-center text-fg', className)} style={{ width: size, height: size }}>
        <LockMark size={size * 0.55} />
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      onClick={play}
      aria-hidden="true"
      className={cn('select-none', className)}
      style={{ width: size, height: size }}
    />
  );
}
