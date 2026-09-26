/**
 * 3D 模型的加载与渲染（three.js），和 React 无关。
 * STL / 3MF / PLY / OFF 按 3D 打印的习惯是 Z 轴朝上、单位毫米；OBJ / glTF 是 Y 轴朝上。
 * 只在浏览器里用，由阅读器按需动态加载，不进主包。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ViewName = 'iso' | 'front' | 'top' | 'side';

export interface ModelInfo {
  /** 宽 × 深 × 高（打印机的 X × Y × Z） */
  size: [number, number, number];
  unit: string;
  triangles: number;
  parts: number;
  /** 模型自带颜色 / 材质 */
  colored: boolean;
}

/** 打印耗材的几种常见颜色；null 表示用模型自带的 */
export const SWATCHES: Array<{ name: string; color: string | null }> = [
  { name: '原色', color: null },
  { name: '陶土灰', color: '#b9b2a8' },
  { name: '象牙白', color: '#efe9df' },
  { name: '石墨黑', color: '#3a3836' },
  { name: '暖金', color: '#c9a26b' },
  { name: '砖红', color: '#b85c45' },
  { name: '湖蓝', color: '#4f7f9c' },
];

const Z_UP = new Set(['stl', '3mf', 'ply', 'off']);
const MM = new Set(['stl', '3mf', 'off']);
/** 超过这么多三角面就不做平滑法线和轮廓线（太慢） */
const DETAIL_LIMIT = 400_000;

/* ------------------------------------------------------------------ */
/* 解析 */
/* ------------------------------------------------------------------ */

function parseOff(text: string): THREE.BufferGeometry {
  const tokens = text.replace(/#.*$/gm, '').split(/\s+/).filter(Boolean);
  let i = 0;
  if (/^[A-Z]*OFF$/.test(tokens[0])) i += 1;
  const nv = Number(tokens[i++]);
  const nf = Number(tokens[i++]);
  i += 1; // 边数
  const verts: number[] = [];
  for (let v = 0; v < nv; v += 1) {
    verts.push(Number(tokens[i]), Number(tokens[i + 1]), Number(tokens[i + 2]));
    i += 3;
  }
  const index: number[] = [];
  for (let f = 0; f < nf; f += 1) {
    const n = Number(tokens[i++]);
    const face = tokens.slice(i, i + n).map(Number);
    i += n;
    for (let k = 1; k < n - 1; k += 1) index.push(face[0], face[k], face[k + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geometry.setIndex(index);
  return geometry;
}

function meshFromGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
  const colored = Boolean(geometry.getAttribute('color'));
  const material = new THREE.MeshStandardMaterial({ vertexColors: colored });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.ownColor = colored;
  return mesh;
}

/** 把文件解析成一个物体（还没摆正） */
export async function parseModel(buffer: ArrayBuffer, ext: string, resourcePath = ''): Promise<THREE.Object3D> {
  switch (ext) {
    case 'stl': {
      const geometry = new STLLoader().parse(buffer);
      return meshFromGeometry(geometry);
    }
    case 'ply':
      return meshFromGeometry(new PLYLoader().parse(buffer));
    case 'off':
      return meshFromGeometry(parseOff(new TextDecoder().decode(buffer)));
    case 'obj': {
      const group = new OBJLoader().parse(new TextDecoder().decode(buffer));
      group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.userData.ownColor = false; });
      return group;
    }
    case '3mf': {
      const group = new ThreeMFLoader().parse(buffer);
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.Material & { color?: THREE.Color; vertexColors?: boolean };
        // 3MF 没指定颜色时加载器给的是纯白，当成没颜色
        mesh.userData.ownColor = Boolean(mat.vertexColors) || Boolean(mat.color && mat.color.getHex() !== 0xffffff);
      });
      return group;
    }
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader();
      const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
        const data = ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer;
        loader.parse(data, resourcePath, resolve, reject);
      });
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.userData.ownColor = true; });
      return gltf.scene;
    }
    default:
      throw new Error(`不支持的模型格式：${ext}`);
  }
}

/** 摆正（Z 朝上的转成 Y 朝上）、居中、放到地面上，统计尺寸 */
function prepare(object: THREE.Object3D, ext: string): { root: THREE.Group; info: ModelInfo; box: THREE.Box3 } {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  if (Z_UP.has(ext)) holder.rotation.x = -Math.PI / 2;
  holder.add(object);
  root.add(holder);

  let triangles = 0;
  let parts = 0;
  let colored = false;
  object.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    parts += 1;
    const g = mesh.geometry;
    const count = g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
    triangles += count;
    if (mesh.userData.ownColor) colored = true;
  });

  // 平滑曲面、保留棱角：打印模型通常只有面法线，直接画是一格一格的
  if (triangles < DETAIL_LIMIT && ext !== 'glb' && ext !== 'gltf') {
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      try {
        mesh.geometry = toCreasedNormals(mesh.geometry, THREE.MathUtils.degToRad(30));
      } catch {
        mesh.geometry.computeVertexNormals();
      }
    });
  }

  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -box.min.y, -center.z);
  root.updateMatrixWorld(true);
  box.setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  return {
    root,
    box,
    info: {
      size: [size.x, size.z, size.y],
      unit: MM.has(ext) ? 'mm' : ext === 'glb' || ext === 'gltf' ? 'm' : '',
      triangles: Math.round(triangles),
      parts,
      colored,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 灯光与材质 */
/* ------------------------------------------------------------------ */

function studioLights(scene: THREE.Scene, radius: number, shadows: boolean) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8174, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(radius * 1.6, radius * 3, radius * 1.2);
  if (shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const s = radius * 2.2;
    Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: radius * 0.1, far: radius * 10 });
    key.shadow.radius = 6;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = radius * 0.004;
  }
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xfff4e8, 0.5);
  rim.position.set(-radius * 2, radius * 1.2, -radius * 1.6);
  scene.add(rim);
}

function applyColor(root: THREE.Object3D, color: string | null, wireframe: boolean) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.userData.originalMaterial) mesh.userData.originalMaterial = mesh.material;
    const useOwn = color === null && mesh.userData.ownColor;
    if (useOwn) {
      mesh.material = mesh.userData.originalMaterial;
    } else {
      const mat = (mesh.userData.clay as THREE.MeshStandardMaterial | undefined) ?? new THREE.MeshStandardMaterial({
        roughness: 0.62,
        metalness: 0.04,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      mesh.userData.clay = mat;
      mat.color.set(color ?? SWATCHES[1].color!);
      mesh.material = mat;
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      (m as THREE.MeshStandardMaterial).wireframe = wireframe;
      m.needsUpdate = true;
    }
  });
}

function niceStep(value: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  for (const m of [1, 2, 5, 10]) if (value <= m * exp) return m * exp;
  return 10 * exp;
}

/* ------------------------------------------------------------------ */
/* 舞台：一个可交互的视图 */
/* ------------------------------------------------------------------ */

export interface StageOptions {
  dark: boolean;
  onFirstInteraction?: () => void;
  onAutoRotateChange?: (on: boolean) => void;
}

const VIEW_DIRS: Record<ViewName, THREE.Vector3> = {
  iso: new THREE.Vector3(1, 0.85, 1.25).normalize(),
  front: new THREE.Vector3(0, 0.02, 1).normalize(),
  top: new THREE.Vector3(0, 1, 0.0008).normalize(),
  side: new THREE.Vector3(1, 0.02, 0).normalize(),
};

export class ModelStage {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  private controls: OrbitControls;
  private pmrem: THREE.PMREMGenerator;
  private root: THREE.Group | null = null;
  private edges: THREE.LineSegments[] = [];
  private grid: THREE.GridHelper | null = null;
  private ground: THREE.Mesh | null = null;
  private radius = 1;
  private center = new THREE.Vector3();
  private dirty = true;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; fromTarget: THREE.Vector3; start: number } | null = null;
  private observer: ResizeObserver;
  private interacted = false;
  private color: string | null = null;
  private wireframe = false;

  constructor(private host: HTMLElement, private options: StageOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    host.appendChild(this.renderer.domElement);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 1.1;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => {
      this.flight = null;
      if (!this.interacted) {
        this.interacted = true;
        this.options.onFirstInteraction?.();
      }
      if (this.controls.autoRotate) {
        this.controls.autoRotate = false;
        this.options.onAutoRotateChange?.(false);
      }
    });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  private tick() {
    if (document.hidden) return;
    if (this.flight) {
      const t = Math.min(1, (performance.now() - this.flight.start) / 520);
      const e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, e);
      this.controls.target.lerpVectors(this.flight.fromTarget, this.center, e);
      if (t >= 1) this.flight = null;
      this.dirty = true;
    }
    const moved = this.controls.update();
    if (moved || this.dirty || this.controls.autoRotate) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
  }

  setModel(object: THREE.Object3D, ext: string): ModelInfo {
    const { root, info, box } = prepare(object, ext);
    this.root = root;
    const size = box.getSize(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.radius = Math.max(sphere.radius, 1e-3);
    this.center.copy(sphere.center);

    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
    });
    this.scene.add(root);
    studioLights(this.scene, this.radius, true);

    // 地面：只接影子；网格按模型大小取整齐的格距（毫米模型多半是 5 / 10 mm 一格）
    const span = Math.max(size.x, size.z) * 2.4;
    const step = niceStep(Math.max(size.x, size.z) / 5);
    const extent = Math.ceil(span / step) * step;
    const shadowMat = new THREE.ShadowMaterial({ opacity: this.options.dark ? 0.35 : 0.16 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 3, extent * 3), shadowMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const lineColor = this.options.dark ? 0x4a4744 : 0xcfc9c0;
    this.grid = new THREE.GridHelper(extent, Math.round(extent / step), lineColor, lineColor);
    const gridMat = this.grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.55;
    this.grid.position.y = this.radius * 0.0005;
    this.scene.add(this.grid);

    // 轮廓线：CAD 软件里那种细棱线，看得清倒角和浮雕
    if (info.triangles < DETAIL_LIMIT) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const line = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry, 32),
          new THREE.LineBasicMaterial({ color: this.options.dark ? 0x000000 : 0x2b2622, transparent: true, opacity: this.options.dark ? 0.35 : 0.2 }),
        );
        mesh.add(line);
        this.edges.push(line);
      });
    }

    this.color = info.colored ? null : SWATCHES[1].color;
    applyColor(root, this.color, false);

    this.camera.near = this.radius / 100;
    this.camera.far = this.radius * 100;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.radius * 0.3;
    this.controls.maxDistance = this.radius * 12;
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(VIEW_DIRS.iso, this.fitDistance());
    this.controls.autoRotate = true;
    this.dirty = true;
    return info;
  }

  private fitDistance() {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = this.radius / Math.sin(fov / 2);
    const fitW = fitH / Math.min(1, this.camera.aspect);
    return Math.max(fitH, fitW) * 1.08;
  }

  view(name: ViewName) {
    this.flight = {
      from: this.camera.position.clone(),
      to: this.center.clone().addScaledVector(VIEW_DIRS[name], this.fitDistance()),
      fromTarget: this.controls.target.clone(),
      start: performance.now(),
    };
  }

  setAutoRotate(on: boolean) {
    this.controls.autoRotate = on;
    this.dirty = true;
  }

  setWireframe(on: boolean) {
    this.wireframe = on;
    if (this.root) applyColor(this.root, this.color, on);
    for (const e of this.edges) e.visible = !on;
    this.dirty = true;
  }

  setEdges(on: boolean) {
    for (const e of this.edges) e.visible = on && !this.wireframe;
    this.dirty = true;
  }

  get hasEdges() {
    return this.edges.length > 0;
  }

  setGrid(on: boolean) {
    if (this.grid) this.grid.visible = on;
    this.dirty = true;
  }

  setColor(color: string | null) {
    this.color = color;
    if (this.root) applyColor(this.root, color, this.wireframe);
    this.dirty = true;
  }

  /** 当前画面存成 PNG */
  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.observer.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose();
      const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
      for (const m of mats) m.dispose();
      (mesh.userData?.clay as THREE.Material | undefined)?.dispose();
    });
    this.scene.environment?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/* ------------------------------------------------------------------ */
/* 文件卡片上的缩略图：共用一个小渲染器，排队一张张画 */
/* ------------------------------------------------------------------ */

const THUMB_SIZE = 160;
const thumbCache = new Map<string, Promise<string | null>>();
let thumbQueue: Promise<unknown> = Promise.resolve();
let thumbRenderer: THREE.WebGLRenderer | null = null;

async function renderThumb(url: string, ext: string): Promise<string | null> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) return null;
  const object = await parseModel(await res.arrayBuffer(), ext, url.replace(/[^/]*$/, ''));
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(2);
    thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
    thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
  }
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(thumbRenderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const { root, info, box } = prepare(object, ext);
  applyColor(root, info.colored ? null : SWATCHES[1].color, false);
  scene.add(root);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  studioLights(scene, sphere.radius, false);
  const camera = new THREE.PerspectiveCamera(30, 1, sphere.radius / 100, sphere.radius * 100);
  camera.position.copy(sphere.center).addScaledVector(VIEW_DIRS.iso, (sphere.radius / Math.sin(THREE.MathUtils.degToRad(15))) * 1.02);
  camera.lookAt(sphere.center);
  thumbRenderer.render(scene, camera);
  const data = thumbRenderer.domElement.toDataURL('image/png');
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) m.dispose();
  });
  scene.environment?.dispose();
  pmrem.dispose();
  return data;
}

export function modelThumbnail(url: string, ext: string): Promise<string | null> {
  let job = thumbCache.get(url);
  if (!job) {
    job = thumbQueue.then(() => renderThumb(url, ext)).catch(() => null);
    thumbQueue = job;
    thumbCache.set(url, job);
  }
  return job;
}
