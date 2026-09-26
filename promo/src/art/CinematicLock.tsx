import { useLayoutEffect, useRef } from 'react';
import { continueRender, delayRender } from 'remotion';

/*
 * 品牌锁的"电影版"：几何和产品里的 LockOrb 完全一致（圆角锁身 + 两道竖槽 + 锁梁），
 * 换成电影用光：程序化柔光箱环境反射、软阴影、AO、竖槽自发光和光晕、镜头参数全部按帧驱动。
 * 一帧画一次，不跑 requestAnimationFrame，保证渲染是确定的。
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform vec3 uCamTarget;
uniform float uCamRoll;
uniform float uFov;
uniform float uLift;
uniform float uRoll;
uniform float uSweep;      // 柔光箱绕锁转的角度（光扫过金属）
uniform float uKey;        // 主光强度
uniform float uRim;        // 轮廓光强度
uniform float uGlowL;      // 左槽（暖白）
uniform float uGlowR;      // 右槽（琥珀）
uniform float uBodyLight;  // 锁身明度：0 石墨黑，1 暖白瓷
uniform float uExposure;
uniform float uTime;
uniform vec3 uBg;
uniform float uClear;     // 1 = 透明背景（叠在浅色界面上）
uniform float uAmbient;

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

// 两道竖槽（分开算，左右光晕各自叠加）
vec2 slotPair(vec3 p) {
  vec3 pb = p - vec3(0.0, -0.36, 0.0);
  float l = sdRoundBox(pb - vec3(-0.065, -0.02, 0.25), vec3(0.026, 0.14, 0.06), 0.02);
  float r = sdRoundBox(pb - vec3(0.065, -0.02, 0.25), vec3(0.026, 0.14, 0.06), 0.02);
  return vec2(l, r);
}

vec2 map(vec3 p) {
  vec3 pb = p - vec3(0.0, -0.36, 0.0);
  float bodyRaw = sdRoundBox(pb, vec3(0.6, 0.46, 0.25), 0.17);
  vec2 sp = slotPair(p);
  float slots = min(sp.x, sp.y);
  float body = max(bodyRaw, -slots);

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

  vec2 res = vec2(body, -slots > bodyRaw - 0.002 ? 3.0 : 1.0);
  if (shackle < res.x) res = vec2(shackle, 2.0);
  return res;
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(0.0007, -0.0007);
  return normalize(
    e.xyy * map(p + e.xyy).x +
    e.yyx * map(p + e.yyx).x +
    e.yxy * map(p + e.yxy).x +
    e.xxx * map(p + e.xxx).x);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 6; i++) {
    float h = 0.01 + 0.07 * float(i);
    occ += (h - map(p + h * n).x) * sca;
    sca *= 0.78;
  }
  return clamp(1.0 - 2.0 * occ, 0.0, 1.0);
}

float softShadow(vec3 ro, vec3 rd) {
  float res = 1.0, t = 0.02;
  for (int i = 0; i < 48; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.01, 0.12);
    if (res < 0.002 || t > 3.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

// 程序化摄影棚：顶上一条长柔光箱、侧面一块竖向柔光箱，随 uSweep 绕锁转；其余是很暗的暖灰
vec3 studio(vec3 d) {
  vec3 q = d;
  q.xz = rot(uSweep) * q.xz;
  vec3 col = uBg * 0.6 + vec3(0.012, 0.011, 0.01) * (0.5 + 0.5 * q.y);
  // 顶光箱：细长横条
  float top = smoothstep(0.62, 0.72, q.y) * smoothstep(0.55, 0.2, abs(q.x));
  // 主光箱：左前方竖条
  float a = atan(q.x, q.z);
  float key = smoothstep(0.16, 0.06, abs(a + 0.9)) * smoothstep(0.75, 0.35, abs(q.y - 0.12));
  // 轮廓光：右后方细条
  float rim = smoothstep(0.08, 0.02, abs(a - 2.3)) * smoothstep(0.8, 0.2, abs(q.y));
  col += vec3(1.0, 0.97, 0.92) * (top * 1.6 + key * 2.4) * uKey;
  col += vec3(1.0, 0.72, 0.42) * rim * 3.0 * uRim;
  return col;
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec4 render(vec2 frag) {
  vec2 uv = (frag - 0.5 * uRes) / uRes.y;
  vec3 ro = uCamPos;
  vec3 fw = normalize(uCamTarget - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec2 uvr = rot(uCamRoll) * uv;
  vec3 rd = normalize(fw * uFov + rt * uvr.x + up * uvr.y);

  float t = 0.0;
  vec2 hit = vec2(-1.0);
  vec2 minSlot = vec2(1e3);
  for (int i = 0; i < 160; i++) {
    vec3 p = ro + rd * t;
    minSlot = min(minSlot, slotPair(p));
    vec2 d = map(p);
    if (d.x < 0.0004 * (1.0 + t)) { hit = vec2(t, d.y); break; }
    t += d.x * 0.85;
    if (t > 14.0) break;
  }

  // 背景：极暗的暖色渐变 + 从右上来的一点光雾
  vec3 bg = uBg * (0.85 + 0.3 * (uv.y + 0.5));
  bg += vec3(1.0, 0.7, 0.4) * 0.018 * uKey * exp(-3.0 * length(uv - vec2(0.55, 0.45)));
  vec3 col = bg * (1.0 - uClear);
  float alpha = 1.0 - uClear;

  vec3 glowL = vec3(1.0, 0.93, 0.84);
  vec3 glowR = vec3(1.0, 0.56, 0.2);

  if (hit.x > 0.0) {
    alpha = 1.0;
    vec3 p = ro + rd * hit.x;
    vec3 n = calcNormal(p);
    vec3 v = -rd;
    float ao = calcAO(p, n);
    vec3 keyDir = normalize(vec3(-0.6, 0.75, 0.55));
    keyDir.xz = rot(-uSweep) * keyDir.xz;
    float sh = softShadow(p + n * 0.003, keyDir);
    float ndl = clamp(dot(n, keyDir), 0.0, 1.0);
    float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
    vec3 r = reflect(-v, n);

    if (hit.y == 2.0) {
      // 锁梁：抛光钢，主要靠反射柔光箱
      vec3 f0 = vec3(0.86, 0.84, 0.8);
      vec3 F = f0 + (1.0 - f0) * fres;
      col = studio(r) * F * mix(0.35, 1.0, ao);
      col += f0 * ndl * sh * 0.08 * uKey;
    } else if (hit.y == 3.0) {
      // 竖槽内壁：自发光
      float side = p.x < 0.0 ? -1.0 : 1.0;
      vec3 g = side < 0.0 ? glowL * uGlowL : glowR * uGlowR;
      float depth = clamp((0.25 + 0.06 - (p.z)) / 0.08, 0.0, 1.0);
      col = g * (1.6 - 0.9 * depth) + vec3(0.02) * ao;
    } else {
      // 锁身：粉末涂层 —— 细颗粒的粗糙高光，暗部带一点暖
      float grain = hash(floor(p.xy * 900.0) + floor(p.z * 900.0)) * 0.06;
      vec3 base = mix(vec3(0.028, 0.026, 0.025), vec3(0.86, 0.84, 0.8), uBodyLight) * (0.97 + grain);
      vec3 h = normalize(keyDir + v);
      float spec = pow(clamp(dot(n, h), 0.0, 1.0), 38.0) * (0.4 + 0.6 * fres);
      vec3 diff = base * (uAmbient + ndl * sh * 1.1 * uKey) * ao;
      vec3 env = studio(r) * (0.04 + 0.5 * fres) * mix(0.35, 1.0, ao);
      col = diff + env + vec3(1.0, 0.96, 0.9) * spec * sh * 0.55 * uKey;
      // 轮廓：边缘一圈暖色掠光
      col += vec3(1.0, 0.72, 0.45) * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0) * 0.18 * uRim;
      // 竖槽把光打到附近的锁身上
      vec2 sd = slotPair(p);
      float facing = clamp(n.z, 0.0, 1.0);
      col += (glowL * uGlowL * exp(-sd.x * 40.0) + glowR * uGlowR * exp(-sd.y * 40.0)) * 0.3 * facing;
    }
    // 远处雾化到背景
    col = mix(col, bg, (1.0 - uClear) * (1.0 - exp(-0.004 * hit.x * hit.x)));
  }

  // 光晕：光线离竖槽最近的距离
  vec2 halo = exp(-minSlot * 55.0) * 0.5 + exp(-minSlot * 9.0) * 0.1;
  if (hit.y == 3.0) halo *= 0.4;
  vec3 hc = glowL * uGlowL * halo.x + glowR * uGlowR * halo.y;
  col += hc;
  alpha = max(alpha, clamp(max(hc.r, max(hc.g, hc.b)), 0.0, 1.0));

  return vec4(col, alpha);
}

void main() {
  // 2×2 超采样抗锯齿
  vec3 acc = vec3(0.0);
  float aAcc = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    vec4 r = render(gl_FragCoord.xy + (vec2(float(i), float(j)) - 0.5) * 0.5);
    acc += r.rgb * r.a;
    aAcc += r.a;
  }
  float a = aAcc / 4.0;
  vec3 col = aAcc > 0.0 ? acc / aAcc : vec3(0.0);
  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  // 极轻的颗粒在 DOM 层统一加；这里只做一点点抖动防止色带
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  gl_FragColor = vec4(col * a, a);
}
`;

export interface LockCam {
  pos: [number, number, number];
  target: [number, number, number];
  roll?: number;
  fov?: number;
}

export interface LockState {
  cam: LockCam;
  lift: number;
  roll?: number;
  sweep: number;
  key: number;
  rim: number;
  glowL: number;
  glowR: number;
  bodyLight?: number;
  exposure?: number;
  bg?: [number, number, number];
  clear?: boolean;
  ambient?: number;
  time: number;
}

interface Props {
  width: number;
  height: number;
  state: LockState;
  /** 画布实际分辨率相对显示尺寸的比例 */
  scale?: number;
  style?: React.CSSProperties;
}

export function CinematicLock({ width, height, state, scale = 1, style }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<{ gl: WebGLRenderingContext; uni: Record<string, WebGLUniformLocation | null> } | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || glRef.current) return;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: true, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL 不可用');
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const names = ['uRes', 'uCamPos', 'uCamTarget', 'uCamRoll', 'uFov', 'uLift', 'uRoll', 'uSweep', 'uKey', 'uRim',
      'uGlowL', 'uGlowR', 'uBodyLight', 'uExposure', 'uTime', 'uBg', 'uClear', 'uAmbient'];
    const uni: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) uni[n] = gl.getUniformLocation(program, n);
    glRef.current = { gl, uni };
  }, []);

  useLayoutEffect(() => {
    const ctx = glRef.current;
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    const handle = delayRender('lock frame');
    const { gl, uni } = ctx;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const s = state;
    gl.uniform2f(uni.uRes, w, h);
    gl.uniform3fv(uni.uCamPos, s.cam.pos);
    gl.uniform3fv(uni.uCamTarget, s.cam.target);
    gl.uniform1f(uni.uCamRoll, s.cam.roll ?? 0);
    gl.uniform1f(uni.uFov, s.cam.fov ?? 2.2);
    gl.uniform1f(uni.uLift, s.lift);
    gl.uniform1f(uni.uRoll, s.roll ?? 0);
    gl.uniform1f(uni.uSweep, s.sweep);
    gl.uniform1f(uni.uKey, s.key);
    gl.uniform1f(uni.uRim, s.rim);
    gl.uniform1f(uni.uGlowL, s.glowL);
    gl.uniform1f(uni.uGlowR, s.glowR);
    gl.uniform1f(uni.uBodyLight, s.bodyLight ?? 0);
    gl.uniform1f(uni.uExposure, s.exposure ?? 1);
    gl.uniform1f(uni.uTime, s.time);
    gl.uniform3fv(uni.uBg, s.bg ?? [0.012, 0.011, 0.01]);
    gl.uniform1f(uni.uClear, s.clear ? 1 : 0);
    gl.uniform1f(uni.uAmbient, s.ambient ?? 0.05);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
    continueRender(handle);
  });

  return <canvas ref={canvasRef} style={{ width, height, display: 'block', ...style }} />;
}
