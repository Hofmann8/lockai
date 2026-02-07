'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import {
  Download,
  ZoomIn,
  ZoomOut,
  Loader2,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  List,
  Image,
} from 'lucide-react';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFPreviewProps {
  pdfUrl: string;
  proxyUrl?: string;
  onDownload?: () => void;
}

interface OutlineItem {
  title: string;
  page: number;
  level: number;
}

type SidebarTab = 'thumbs' | 'outline';

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5];
const DEFAULT_ZOOM_INDEX = 4; // 1.5x = 150%
const THUMB_WIDTH = 156;
const SIDEBAR_WIDTH = 192;

export function PDFPreview({ pdfUrl, proxyUrl, onDownload }: PDFPreviewProps) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('thumbs');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);

  const viewerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const thumbRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  const scale = ZOOM_STEPS[zoomIndex];
  const src = proxyUrl || pdfUrl;
  const pageNumbers = useMemo(() => Array.from({ length: numPages }, (_, i) => i + 1), [numPages]);

  /* ---- reset paging state when source changes ---- */
  useEffect(() => {
    setNumPages(0);
    setCurrentPage(1);
    setLoading(true);
    setError(null);
    setOutline([]);
    setPdfDoc(null);
    pageRefs.current.clear();
    thumbRefs.current.clear();
  }, [src]);

  /* ---- extract outline ---- */
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;

    async function extractOutline(doc: PDFDocumentProxy) {
      const raw = await doc.getOutline();
      if (!raw || cancelled) return;

      const items: OutlineItem[] = [];
      async function walk(entries: typeof raw, level: number) {
        for (const entry of entries) {
          let page = 1;
          if (entry.dest) {
            const dest = typeof entry.dest === 'string'
              ? await doc.getDestination(entry.dest)
              : entry.dest;
            if (dest) {
              const idx = await doc.getPageIndex(dest[0]);
              page = idx + 1;
            }
          }
          items.push({ title: entry.title, page, level });
          if (entry.items?.length) await walk(entry.items, level + 1);
        }
      }
      await walk(raw, 0);
      if (!cancelled) setOutline(items);
    }

    extractOutline(pdfDoc);
    return () => { cancelled = true; };
  }, [pdfDoc]);

  const onDocumentLoadSuccess = useCallback((pdf: PDFDocumentProxy) => {
    setNumPages(pdf.numPages);
    setCurrentPage(1);
    setLoading(false);
    setError(null);
    setPdfDoc(pdf);
  }, []);

  const onDocumentLoadError = useCallback(() => {
    setNumPages(0);
    setCurrentPage(1);
    setPdfDoc(null);
    setOutline([]);
    setLoading(false);
    setError('PDF 加载失败');
  }, []);

  const jumpTo = useCallback((page: number) => {
    const clamped = Math.max(1, Math.min(numPages, page));
    setCurrentPage(clamped);
    const el = pageRefs.current.get(clamped);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [numPages]);

  const zoomIn = useCallback(() => {
    setZoomIndex(i => Math.min(ZOOM_STEPS.length - 1, i + 1));
  }, []);

  const zoomOut = useCallback(() => {
    setZoomIndex(i => Math.max(0, i - 1));
  }, []);

  /* ---- track current page via scroll position ---- */
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || numPages === 0) return;

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const viewerTop = viewer.getBoundingClientRect().top;
        let closest = 1;
        let closestDist = Infinity;
        for (const [n, el] of pageRefs.current) {
          const dist = Math.abs(el.getBoundingClientRect().top - viewerTop);
          if (dist < closestDist) {
            closestDist = dist;
            closest = n;
          }
        }
        setCurrentPage(closest);
        ticking = false;
      });
    };

    viewer.addEventListener('scroll', onScroll, { passive: true });
    return () => viewer.removeEventListener('scroll', onScroll);
  }, [numPages]);

  /* ---- sync thumbnail highlight ---- */
  useEffect(() => {
    if (sidebarTab !== 'thumbs') return;
    const el = thumbRefs.current.get(currentPage);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentPage, sidebarTab]);

  // 兜底：numPages 更新后保证 currentPage 不越界。
  useEffect(() => {
    if (numPages === 0) {
      if (currentPage !== 1) setCurrentPage(1);
      return;
    }
    if (currentPage > numPages) {
      setCurrentPage(numPages);
    }
  }, [numPages, currentPage]);

  /* ---- keyboard shortcuts ---- */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === '=') { e.preventDefault(); zoomIn(); }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomOut(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut]);

  const handleDownload = () => {
    if (onDownload) onDownload();
    else window.open(pdfUrl, '_blank');
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
          >
            {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </button>

          <div className="w-px h-5 bg-border" />

          <span className="text-xs text-muted-foreground tabular-nums min-w-16 text-center select-none">
            {numPages > 0 ? `${currentPage} / ${numPages}` : '—'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoomIndex <= 0}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            aria-label="缩小"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground tabular-nums min-w-12 text-center select-none">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            disabled={zoomIndex >= ZOOM_STEPS.length - 1}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
            aria-label="放大"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <div className="w-px h-5 bg-border mx-1" />

          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            aria-label="下载 PDF"
          >
            <Download className="w-3.5 h-3.5" />
            下载
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div
          className="shrink-0 border-r border-border bg-muted/30 overflow-hidden flex flex-col transition-[width] duration-250 ease-in-out"
          style={{ width: sidebarOpen ? SIDEBAR_WIDTH : 0 }}
        >
          <div className="flex shrink-0 border-b border-border">
            <button
              onClick={() => setSidebarTab('thumbs')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs transition-colors cursor-pointer ${
                sidebarTab === 'thumbs'
                  ? 'text-primary border-b-2 border-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Image className="w-3.5 h-3.5" />
              页面
            </button>
            <button
              onClick={() => setSidebarTab('outline')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs transition-colors cursor-pointer ${
                sidebarTab === 'outline'
                  ? 'text-primary border-b-2 border-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              章节
            </button>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden">
            {sidebarTab === 'thumbs' && (
              <div className="p-2 flex flex-col gap-2">
                {loading && (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                )}
                <Document key={`thumb-${src}`} file={src} loading="">
                  {pageNumbers.map(n => (
                    <button
                      key={n}
                      ref={el => { if (el) thumbRefs.current.set(n, el); }}
                      onClick={() => jumpTo(n)}
                      className={`
                        w-full rounded-lg overflow-hidden border-2 transition-all duration-150 cursor-pointer mb-2
                        ${n === currentPage
                          ? 'border-primary shadow-sm shadow-primary/20'
                          : 'border-transparent hover:border-border'
                        }
                      `}
                    >
                      <Page
                        pageNumber={n}
                        width={THUMB_WIDTH}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        loading=""
                      />
                      <div className={`text-center py-1 text-[11px] tabular-nums ${
                        n === currentPage ? 'text-primary font-medium' : 'text-muted-foreground'
                      }`}>
                        {n}
                      </div>
                    </button>
                  ))}
                </Document>
              </div>
            )}

            {sidebarTab === 'outline' && (
              <div className="py-2">
                {outline.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-8">暂无章节信息</p>
                ) : (
                  outline.map((item, i) => (
                    <button
                      key={i}
                      onClick={() => jumpTo(item.page)}
                      className={`
                        w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer
                        hover:bg-muted truncate block
                        ${item.page === currentPage
                          ? 'text-primary font-medium bg-primary/5'
                          : 'text-foreground'
                        }
                      `}
                      style={{ paddingLeft: `${12 + item.level * 14}px` }}
                      title={item.title}
                    >
                      {item.title}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* PDF continuous scroll area */}
        <div
          ref={viewerRef}
          className="flex-1 overflow-auto bg-muted/20"
        >
          <Document
            key={`main-${src}`}
            file={src}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={
              <div className="flex items-center justify-center py-32">
                <Loader2 className="w-6 h-6 text-primary animate-spin" />
              </div>
            }
            error={
              <div className="flex flex-col items-center justify-center py-32 gap-2">
                <FileText className="w-8 h-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">PDF 加载失败</p>
              </div>
            }
            className="flex flex-col items-center py-4 gap-4"
          >
            {pageNumbers.map(n => (
              <div
                key={n}
                ref={el => { if (el) pageRefs.current.set(n, el); }}
              >
                <Page
                  pageNumber={n}
                  scale={scale}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  className="shadow-lg rounded-sm"
                  loading=""
                />
              </div>
            ))}
          </Document>

        </div>
      </div>

    </div>
  );
}
