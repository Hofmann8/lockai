'use client';

import { useEffect, useState } from 'react';
import type { FileArtifact } from '@/types';
import { fileExt } from '@/lib/chat/artifacts';
import { Dot, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';

interface Slide {
  title: string;
  body: string[];
  image?: string;
}

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const NS_DRAW = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';

const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml');

/** PPTX：每页的标题、文字和第一张图 */
async function pptxSlides(buffer: ArrayBuffer, urls: string[]): Promise<Slide[]> {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(buffer));
  const dec = new TextDecoder();
  const names = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  return names.map((name) => {
    const doc = parse(dec.decode(files[name]));
    let title = '';
    const body: string[] = [];
    for (const sp of Array.from(doc.getElementsByTagNameNS(NS_P, 'sp'))) {
      const ph = sp.getElementsByTagNameNS(NS_P, 'ph')[0];
      const isTitle = ph && /title|ctrTitle/i.test(ph.getAttribute('type') ?? '');
      const paras = Array.from(sp.getElementsByTagNameNS(NS_A, 'p'))
        .map((p) => Array.from(p.getElementsByTagNameNS(NS_A, 't')).map((t) => t.textContent).join('').trim())
        .filter(Boolean);
      if (isTitle && !title) title = paras.join(' ');
      else body.push(...paras);
    }
    if (!title && body.length) title = body.shift()!;
    // 第一张图片
    let image: string | undefined;
    const rels = files[name.replace('slides/', 'slides/_rels/') + '.rels'];
    if (rels) {
      const target = Array.from(parse(dec.decode(rels)).getElementsByTagName('Relationship'))
        .find((r) => /\/image$/.test(r.getAttribute('Type') ?? ''))?.getAttribute('Target');
      const path = target ? `ppt/${target.replace(/^\.\.\//, '')}` : '';
      if (files[path] && /\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
        image = URL.createObjectURL(new Blob([files[path] as BlobPart], { type: path.endsWith('.svg') ? 'image/svg+xml' : '' }));
        urls.push(image);
      }
    }
    return { title, body, image };
  });
}

/** ODP / ODT：content.xml 里的段落（演示文稿按页分） */
async function odfOutline(buffer: ArrayBuffer, ext: string): Promise<Slide[]> {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'content.xml' });
  const doc = parse(new TextDecoder().decode(files['content.xml']));
  const texts = (root: Element) =>
    [...Array.from(root.getElementsByTagNameNS(NS_TEXT, 'h')), ...Array.from(root.getElementsByTagNameNS(NS_TEXT, 'p'))]
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((n) => n.textContent?.trim() ?? '')
      .filter(Boolean);
  if (ext === 'odp') {
    return Array.from(doc.getElementsByTagNameNS(NS_DRAW, 'page')).map((page) => {
      const lines = texts(page);
      return { title: lines[0] ?? '', body: lines.slice(1) };
    });
  }
  return [{ title: '', body: texts(doc.documentElement) }];
}

/** RTF → 纯文本：去掉控制字，保留段落和中文（\uN 与 \'hh） */
function rtfText(rtf: string): string[] {
  let out = rtf
    .replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\s*\}/g, '')
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((Number(n) + 65536) % 65536));
  const bytes: number[] = [];
  out = out.replace(/(\\'[0-9a-f]{2})+/gi, (m) => {
    bytes.length = 0;
    for (const h of m.match(/[0-9a-f]{2}/gi)!) bytes.push(parseInt(h, 16));
    try {
      return new TextDecoder('gbk').decode(new Uint8Array(bytes));
    } catch {
      return '';
    }
  });
  out = out.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '');
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * 没有现成 PDF 预览的演示文稿 / 文档（用户上传的 PPT、ODF、RTF）：
 * 不做排版，只把每页的标题和文字列出来，至少能看清内容。
 */
export default function OutlineView({ file }: { file: FileArtifact }) {
  const ext = fileExt(file.name);
  const { buffer, error } = useFetched(file.url, 'buffer');
  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    const urls: string[] = [];
    (async () => {
      if (ext === 'pptx') return pptxSlides(buffer, urls);
      if (ext === 'odp' || ext === 'odt') return odfOutline(buffer, ext);
      if (ext === 'rtf') return [{ title: '', body: rtfText(new TextDecoder('latin1').decode(buffer)) }];
      throw new Error('unsupported');
    })()
      .then((s) => { if (!cancelled) setSlides(s); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [buffer, ext]);

  if (error || failed) return <PreviewFallback file={file} note="这个文件没法在网页里预览，下载后用 Office / WPS 打开" />;
  if (!slides) return <Opening />;
  const deck = ext === 'pptx' || ext === 'odp';

  if (!deck) {
    const lines = slides[0]?.body ?? [];
    return (
      <div className="flex h-full flex-col">
        <ViewerBar><span className="font-medium text-fg-soft">{ext.toUpperCase()}</span><Dot /><span>只显示文字内容</span></ViewerBar>
        <div className="min-h-0 flex-1 overflow-y-auto bg-sunken px-5 py-5">
          <article className="mx-auto max-w-[720px] rounded-[3px] bg-surface px-10 py-9 text-[14.5px] leading-[1.85] text-fg shadow-[0_0_0_1px_oklch(0_0_0/0.05),0_2px_12px_-2px_oklch(0.2_0.01_60/0.14)]">
            {lines.map((l, i) => <p key={i} className="mb-3">{l}</p>)}
          </article>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ViewerBar>
        <span className="font-medium text-fg-soft">演示文稿</span>
        <Dot />
        <span className="tabular-nums">{slides.length} 页</span>
        <Dot />
        <span>大纲视图，版式以下载后为准</span>
      </ViewerBar>
      <div className="min-h-0 flex-1 overflow-y-auto bg-sunken px-5 py-5">
        <ol className="mx-auto max-w-2xl space-y-4">
          {slides.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-6 shrink-0 pt-3 text-right text-[11.5px] tabular-nums text-fg-faint">{i + 1}</span>
              <div className="flex aspect-[16/9] min-w-0 flex-1 gap-4 overflow-hidden rounded-xl bg-surface p-6 shadow-[0_0_0_1px_oklch(0_0_0/0.05),0_2px_10px_-2px_oklch(0.2_0.01_60/0.14)]">
                <div className="min-w-0 flex-1">
                  <p className="text-[17px] font-semibold leading-snug text-fg">{s.title || '（无标题）'}</p>
                  <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-fg-soft">
                    {s.body.slice(0, 9).map((b, j) => <li key={j} className="line-clamp-2">{b}</li>)}
                    {s.body.length > 9 && <li className="text-fg-faint">……</li>}
                  </ul>
                </div>
                {s.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.image} alt="" className="max-h-full w-2/5 self-center rounded-lg object-contain" />
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
