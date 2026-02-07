'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { generatePaper, revisePaper, getPaperPdfProxyUrl, getPaperStatus } from '@/lib/api';
import { getAuthState } from '@/lib/auth';
import { useAppShell } from '@/components/AppShell';
import { GenerateForm, ProgressView, PDFPreview } from '@/components/paper';
import type { PaperEvent } from '@/types';
import { Send, Loader2 } from 'lucide-react';

type PageState = 'idle' | 'generating' | 'completed' | 'revising' | 'error';

export default function PaperPage() {
  const { loadPaperRecords, currentPaperId, setCurrentPaperId, paperRecords, paperNewProjectTick } = useAppShell();
  const [state, setState] = useState<PageState>('idle');
  const [stage, setStage] = useState('');
  const [detail, setDetail] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [activePaperId, setActivePaperId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [reviseInput, setReviseInput] = useState('');
  const [isRevising, setIsRevising] = useState(false);
  const hasMountedRef = useRef(false);

  const resetPageState = useCallback(() => {
    setState('idle');
    setStage('');
    setDetail('');
    setPdfUrl('');
    setActivePaperId(null);
    setErrorMessage('');
    setReviseInput('');
    setIsRevising(false);
  }, []);

  // 点击侧栏“新项目”时强制回到初始态。
  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    resetPageState();
    setCurrentPaperId(null);
  }, [paperNewProjectTick, resetPageState, setCurrentPaperId]);

  // 侧边栏点击 paper record 时加载
  useEffect(() => {
    if (!currentPaperId) return;
    const record = paperRecords.find(r => r.id === currentPaperId);
    if (!record) return;

    setActivePaperId(record.id);

    if (record.pdf_url) {
      setPdfUrl(record.pdf_url);
      setState('completed');
      setErrorMessage('');
      return;
    }

    if (record.status === 'failed') {
      setState('error');
      setStage('compiling');
      setDetail('论文生成失败');
      setErrorMessage(record.error || '生成失败');
      return;
    }

    // 无 PDF 但记录已存在：说明仍在处理中（或中断后可恢复查询）
    setState('generating');
    setStage(record.status || 'planning');
    setDetail('正在恢复生成进度...');
    setErrorMessage('');
  }, [currentPaperId, paperRecords]);

  // 当选中进行中的论文时，轮询状态，支持刷新后继续跟踪。
  useEffect(() => {
    if (!activePaperId) return;
    if (state !== 'generating' && state !== 'revising') return;

    let cancelled = false;

    const pollStatus = async () => {
      const status = await getPaperStatus(activePaperId);
      if (!status || cancelled) return;

      if (status.status) {
        setStage(status.status);
      }
      if (status.progress_detail) {
        setDetail(status.progress_detail);
      }

      if (status.status === 'completed' && status.pdf_url) {
        setPdfUrl(status.pdf_url);
        setState('completed');
        setErrorMessage('');
        await loadPaperRecords();
        return;
      }

      if (status.status === 'failed') {
        setState('error');
        setErrorMessage(status.error || '生成失败');
      }
    };

    void pollStatus();
    const timer = window.setInterval(() => {
      void pollStatus();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activePaperId, state, loadPaperRecords]);

  const handleSubmit = useCallback(async (topic: string) => {
    setState('generating');
    setStage('');
    setDetail('准备中...');
    setPdfUrl('');
    setActivePaperId(null);
    setErrorMessage('');

    const authState = getAuthState();
    const userId = authState.user?.id || 'anonymous';

    await generatePaper(
      { topic, user_id: userId },
      (event: PaperEvent) => {
        switch (event.type) {
          case 'session_created':
            setActivePaperId(event.session_id || null);
            if (event.session_id) {
              setCurrentPaperId(event.session_id);
            }
            break;
          case 'progress':
            setStage(event.stage || '');
            setDetail(event.detail || '');
            break;
          case 'completed':
            setPdfUrl(event.pdf_url || '');
            setActivePaperId(event.session_id || null);
            if (event.session_id) {
              setCurrentPaperId(event.session_id);
            }
            setState('completed');
            loadPaperRecords();
            break;
          case 'error':
            setErrorMessage(event.message || '未知错误');
            setState('error');
            break;
        }
      }
    );
  }, [loadPaperRecords, setCurrentPaperId]);

  const handleRevise = useCallback(async () => {
    if (!activePaperId || !reviseInput.trim() || isRevising) return;

    setIsRevising(true);
    setState('revising');
    setStage('revising');
    setDetail('正在处理修改请求...');
    setErrorMessage('');

    await revisePaper(
      activePaperId,
      { instruction: reviseInput.trim() },
      (event: PaperEvent) => {
        switch (event.type) {
          case 'progress':
            setStage(event.stage || '');
            setDetail(event.detail || '');
            break;
          case 'completed':
            setPdfUrl(event.pdf_url || '');
            setState('completed');
            setReviseInput('');
            loadPaperRecords();
            break;
          case 'error':
            setErrorMessage(event.message || '修改失败');
            setState('completed');
            break;
        }
      }
    );

    setIsRevising(false);
  }, [activePaperId, reviseInput, isRevising, loadPaperRecords]);

  const handleReset = useCallback(() => {
    resetPageState();
    setCurrentPaperId(null);
  }, [resetPageState, setCurrentPaperId]);

  /* ---- idle / generating / error: centered layout ---- */
  if (state !== 'completed') {
    return (
      <div className="flex flex-col h-screen pt-12">
        <div className="flex-1 flex items-center justify-center p-6">
          {state === 'idle' && <GenerateForm onSubmit={handleSubmit} />}

          {(state === 'generating' || state === 'revising') && (
            <ProgressView stage={stage} detail={detail} />
          )}

          {state === 'error' && (
            <div className="w-full max-w-2xl mx-auto">
              <ProgressView stage={stage} detail={detail} isError errorMessage={errorMessage} />
              <div className="text-center mt-6">
                <button
                  onClick={handleReset}
                  className="px-6 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors duration-200 cursor-pointer"
                >
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---- completed: full-screen PDF viewer + bottom revise bar ---- */
  return (
    <div className="flex flex-col h-screen pt-12 pb-2 px-3 gap-2">
      {/* PDF viewer fills available space */}
      <div className="flex-1 min-h-0 rounded-2xl overflow-hidden border border-border">
        <PDFPreview
          pdfUrl={pdfUrl}
          proxyUrl={activePaperId ? getPaperPdfProxyUrl(activePaperId) : undefined}
        />
      </div>

      {/* Revise bar pinned at bottom, width aligned with chat */}
      <div className="relative max-w-4xl mx-auto w-full px-4 pb-1">
        <div className="absolute -top-4 left-0 right-0 h-4 bg-gradient-to-t from-background to-transparent pointer-events-none" />
        <div className="px-4 py-2.5 rounded-2xl border border-border bg-card">
          {errorMessage && (
            <div className="mb-2 text-xs text-destructive">{errorMessage}</div>
          )}
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={reviseInput}
              onChange={(e) => setReviseInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRevise()}
              placeholder="输入修改要求，如：把第三章加一段关于xxx的讨论..."
              disabled={isRevising}
              className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground outline-none text-sm"
            />
            <button
              onClick={handleRevise}
              disabled={!reviseInput.trim() || isRevising}
              className="p-2 rounded-xl bg-primary text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors cursor-pointer"
            >
              {isRevising ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground text-center mt-3">
          LockAI 可能会出错，请核实重要信息。仅供日常课程作业的辅助参考，不可用于正式学术发表
        </p>
      </div>
    </div>
  );
}
