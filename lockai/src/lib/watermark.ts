'use client';

import { useEffect, useState } from 'react';
import { getSettings, onSettingsChange } from '@/lib/settings';

/**
 * 生成图片的水印是 OSS 实时加的（地址上的 x-oss-process=image/watermark,…），原图本身没有。
 * 关了水印就把这一步从地址里去掉，同一条处理链里的模糊之类照旧。
 */
export function withoutWatermark(url: string): string {
  const cut = url.indexOf('?');
  if (cut < 0) return url;
  const base = url.slice(0, cut);
  // 不用 URLSearchParams：它会把处理参数里的逗号、斜杠转义掉
  const params = url.slice(cut + 1).split('&').flatMap((param) => {
    if (!param.startsWith('x-oss-process=image/')) return [param];
    const steps = param.slice('x-oss-process=image/'.length).split('/').filter((step) => !step.startsWith('watermark,'));
    return steps.length > 0 ? [`x-oss-process=image/${steps.join('/')}`] : [];
  });
  return params.length > 0 ? `${base}?${params.join('&')}` : base;
}

/** 按设置给出生成图片要用的地址 */
export function generatedImageUrl(url: string, watermark = getSettings().watermark): string {
  return watermark ? url : withoutWatermark(url);
}

/** 设置里的水印开关（跟着设置变化） */
export function useWatermark(): boolean {
  const [watermark, setWatermark] = useState(true);
  useEffect(() => {
    setWatermark(getSettings().watermark);
    return onSettingsChange((s) => setWatermark(s.watermark));
  }, []);
  return watermark;
}
