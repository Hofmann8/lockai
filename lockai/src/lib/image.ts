/**
 * 图片压缩工具
 * 将用户选择的图片压缩到合适大小，输出 base64 data URL
 */

const MAX_DIMENSION = 2048;
const INITIAL_LOSSY_QUALITY = 0.92;
const MIN_LOSSY_QUALITY = 0.72;
const QUALITY_STEP = 0.08;
const RESIZE_STEP = 0.85;
const MAX_TRIES = 8;
const MAX_FILE_SIZE = 4 * 1024 * 1024; // 压缩后上限 4MB（按字节估算）

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = dataUrl;
  });
}

function dataUrlByteSize(dataUrl: string): number {
  const parts = dataUrl.split(',', 2);
  const base64 = parts.length === 2 ? parts[1] : '';
  if (!base64) return 0;
  const padding = (base64.match(/=*$/)?.[0].length || 0);
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function renderToDataUrl(
  img: HTMLImageElement,
  width: number,
  height: number,
  mimeType: string,
  quality?: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 不可用');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL(mimeType, quality);
}

/**
 * 压缩图片文件，返回 base64 data URL
 */
export async function compressImage(file: File): Promise<string> {
  const originalDataUrl = await readFileAsDataUrl(file);

  // GIF 用 Canvas 会丢动画，直接保留原图。
  if (file.type === 'image/gif') {
    return originalDataUrl;
  }

  const img = await loadImage(originalDataUrl);
  const originalWidth = img.naturalWidth || img.width;
  const originalHeight = img.naturalHeight || img.height;

  // 小图直接保留原始编码，避免不必要重压缩导致变糊。
  if (
    file.size <= MAX_FILE_SIZE &&
    originalWidth <= MAX_DIMENSION &&
    originalHeight <= MAX_DIMENSION
  ) {
    return originalDataUrl;
  }

  let width = originalWidth;
  let height = originalHeight;

  // 按长边缩放
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }

  // 透明图优先尝试 PNG，过大再转 WebP；其余统一 JPEG。
  const prefersLossless = file.type === 'image/png';
  const lossyMimeType = file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  let quality = INITIAL_LOSSY_QUALITY;
  let lastResult = originalDataUrl;

  for (let i = 0; i < MAX_TRIES; i += 1) {
    const tryLossless = prefersLossless && i === 0;
    const mimeType = tryLossless ? 'image/png' : lossyMimeType;
    const next = renderToDataUrl(img, width, height, mimeType, mimeType === 'image/png' ? undefined : quality);
    lastResult = next;

    if (dataUrlByteSize(next) <= MAX_FILE_SIZE) {
      return next;
    }

    if (mimeType !== 'image/png' && quality > MIN_LOSSY_QUALITY) {
      quality = Math.max(MIN_LOSSY_QUALITY, quality - QUALITY_STEP);
      continue;
    }

    width = Math.max(320, Math.round(width * RESIZE_STEP));
    height = Math.max(320, Math.round(height * RESIZE_STEP));
  }

  return lastResult;
}

/** 支持的图片 MIME 类型 */
export const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/gif,image/webp';
