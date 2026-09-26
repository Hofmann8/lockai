'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { FileArtifact } from '@/types';
import { useTheme } from '@/lib/theme';
import { BarButton, Dot, Opening, PreviewFallback, useFetched, ViewerBar } from './shared';

interface Book {
  title: string;
  author?: string;
  chapters: Array<{ path: string; title: string }>;
  files: Record<string, Uint8Array>;
}

const decoder = new TextDecoder();

function resolvePath(base: string, href: string): string {
  const parts = base.split('/').slice(0, -1);
  for (const seg of href.split('#')[0].split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(decodeURIComponent(seg));
  }
  return parts.join('/');
}

async function openBook(buffer: ArrayBuffer): Promise<Book> {
  const { unzipSync } = await import('fflate');
  const files = unzipSync(new Uint8Array(buffer));
  const text = (p: string) => (files[p] ? decoder.decode(files[p]) : '');
  const xml = (p: string) => new DOMParser().parseFromString(text(p), 'application/xml');
  const opfPath = xml('META-INF/container.xml').querySelector('rootfile')?.getAttribute('full-path') ?? '';
  const opf = xml(opfPath);
  const manifest = new Map<string, { href: string; type: string; props: string }>();
  opf.querySelectorAll('manifest > item').forEach((item) => {
    manifest.set(item.getAttribute('id') ?? '', {
      href: resolvePath(opfPath, item.getAttribute('href') ?? ''),
      type: item.getAttribute('media-type') ?? '',
      props: item.getAttribute('properties') ?? '',
    });
  });
  // 目录标题：EPUB3 的 nav，没有就用 EPUB2 的 toc.ncx
  const titles = new Map<string, string>();
  const nav = [...manifest.values()].find((m) => m.props.includes('nav'));
  if (nav) {
    new DOMParser().parseFromString(text(nav.href), 'application/xhtml+xml').querySelectorAll('nav a').forEach((a) => {
      const path = resolvePath(nav.href, a.getAttribute('href') ?? '');
      if (!titles.has(path)) titles.set(path, a.textContent?.trim() ?? '');
    });
  } else {
    const ncx = [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    if (ncx) xml(ncx.href).querySelectorAll('navPoint').forEach((p) => {
      const path = resolvePath(ncx.href, p.querySelector('content')?.getAttribute('src') ?? '');
      if (!titles.has(path)) titles.set(path, p.querySelector('text')?.textContent?.trim() ?? '');
    });
  }
  const chapters = [...opf.querySelectorAll('spine > itemref')]
    .map((ref) => manifest.get(ref.getAttribute('idref') ?? ''))
    .filter((m): m is { href: string; type: string; props: string } => Boolean(m && files[m.href]))
    .map((m, i) => ({ path: m.href, title: titles.get(m.href) || `第 ${i + 1} 部分` }));
  return {
    title: opf.querySelector('metadata > title, metadata title')?.textContent?.trim() || '电子书',
    author: opf.querySelector('metadata > creator, metadata creator')?.textContent?.trim() || undefined,
    chapters,
    files,
  };
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

/** 把一章排成可以直接显示的 HTML：图片和样式换成本地地址，去掉脚本，套上阅读排版 */
function renderChapter(book: Book, path: string, dark: boolean, urls: Map<string, string>): string {
  const url = (p: string) => {
    if (!urls.has(p) && book.files[p]) {
      const ext = p.split('.').pop()!.toLowerCase();
      urls.set(p, URL.createObjectURL(new Blob([book.files[p] as BlobPart], { type: MIME[ext] ?? (ext === 'css' ? 'text/css' : 'application/octet-stream') })));
    }
    return urls.get(p) ?? '';
  };
  const doc = new DOMParser().parseFromString(decoder.decode(book.files[path]), 'application/xhtml+xml');
  const html = doc.querySelector('parsererror') ? new DOMParser().parseFromString(decoder.decode(book.files[path]), 'text/html') : doc;
  html.querySelectorAll('script').forEach((s) => s.remove());
  html.querySelectorAll('img[src]').forEach((img) => img.setAttribute('src', url(resolvePath(path, img.getAttribute('src')!))));
  html.querySelectorAll('image').forEach((img) => {
    const href = img.getAttribute('xlink:href') ?? img.getAttribute('href');
    if (href) img.setAttribute('href', url(resolvePath(path, href)));
  });
  html.querySelectorAll('link[rel="stylesheet"][href]').forEach((l) => l.setAttribute('href', url(resolvePath(path, l.getAttribute('href')!))));
  const body = html.querySelector('body')?.innerHTML ?? '';
  const head = [...html.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join('');
  const fg = dark ? '#e8e4de' : '#2b2622';
  const bg = dark ? '#1c1b1a' : '#fdfcfa';
  return `<!doctype html><html><head><meta charset="utf-8">${head}<style>
    html{background:${bg}}
    body{max-width:40em;margin:0 auto;padding:40px 32px 80px;color:${fg};background:${bg};
      font:17px/1.85 "Songti SC","Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;text-align:justify}
    img,svg{max-width:100%;height:auto}
    a{color:inherit}
    h1,h2,h3{line-height:1.35;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  </style></head><body>${body}</body></html>`;
}

/** 电子书：章节切换、上一章 / 下一章（← →），书里的目录链接可以点 */
export default function EpubView({ file }: { file: FileArtifact }) {
  const { resolvedTheme } = useTheme();
  const { buffer, error } = useFetched(file.url, 'buffer');
  const [book, setBook] = useState<Book | null>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const urlsRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    openBook(buffer)
      .then((b) => { if (!cancelled) (b.chapters.length ? setBook(b) : setFailed(true)); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [buffer]);

  useEffect(() => {
    const urls = urlsRef.current;
    return () => { for (const u of urls.values()) URL.revokeObjectURL(u); };
  }, []);

  const html = useMemo(
    () => (book ? renderChapter(book, book.chapters[index].path, resolvedTheme === 'dark', urlsRef.current) : ''),
    [book, index, resolvedTheme],
  );

  useEffect(() => {
    if (!book) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(book.chapters.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [book]);

  if (error || failed) return <PreviewFallback file={file} note="电子书没能打开，可以下载后用阅读器（Apple 图书、多看等）打开" />;
  if (!book) return <Opening label="正在打开电子书" />;

  const chapter = book.chapters[index];
  const onFrameLoad = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    // 书里的目录 / 章节链接：跳到对应章节
    doc.addEventListener('click', (e) => {
      const a = (e.target as Element).closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href')!;
      if (/^https?:/.test(href)) {
        e.preventDefault();
        window.open(href, '_blank', 'noopener');
        return;
      }
      const target = book.chapters.findIndex((c) => c.path === resolvePath(chapter.path, href));
      e.preventDefault();
      if (target >= 0) setIndex(target);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <ViewerBar
        actions={
          <>
            <BarButton label="上一章" disabled={index === 0} onClick={() => setIndex(index - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </BarButton>
            <select
              value={index}
              onChange={(e) => setIndex(Number(e.target.value))}
              className="h-7 max-w-44 truncate rounded-lg bg-surface-2 px-2 text-[12px] text-fg outline-none"
              aria-label="章节"
            >
              {book.chapters.map((c, i) => <option key={c.path} value={i}>{c.title}</option>)}
            </select>
            <BarButton label="下一章" disabled={index === book.chapters.length - 1} onClick={() => setIndex(index + 1)}>
              <ChevronRight className="h-4 w-4" />
            </BarButton>
          </>
        }
      >
        <span className="truncate font-medium text-fg-soft">{book.title}</span>
        {book.author && (<><Dot /><span className="truncate">{book.author}</span></>)}
        <Dot />
        <span className="tabular-nums">{index + 1} / {book.chapters.length}</span>
      </ViewerBar>
      <div className="relative min-h-0 flex-1">
        <iframe
          key={`${index}-${resolvedTheme}`}
          ref={frameRef}
          srcDoc={html}
          onLoad={onFrameLoad}
          title={chapter.title}
          sandbox="allow-same-origin"
          className="h-full w-full animate-fade"
        />
        <div className="absolute inset-x-0 bottom-0 h-0.5 bg-line">
          <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${((index + 1) / book.chapters.length) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
