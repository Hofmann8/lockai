'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { generatePaper, revisePaper, retryPaper, pollPaperStatus, getPaperPdfProxyUrl } from '@/lib/api';
import { getAuthState } from '@/lib/auth';
import { useAppShell } from '@/components/AppShell';
import { PlanChat, ProgressView, PDFPreview } from '@/components/paper';
import { Send, Loader2 } from 'lucide-react';

type PageState = 'idle' | 'generating' | 'completed' | 'revising' | 'error';

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const POLL_INTERVAL = 2000;

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 停止轮询
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 开始轮询某个 paper_id 的状态
  const startPolling = useCallback((paperId: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const record = await pollPaperStatus(paperId);
      if (!record) return;

      setStage(record.status);
      setDetail(record.progress_detail || '');

      if (record.status === 'completed') {
        stopPolling();
        setPdfUrl(record.pdf_url || '');
        setState('completed');
        setErrorMessage('');
        loadPaperRecords();
      } else if (record.status === 'failed') {
        stopPolling();
        setErrorMessage(record.error || '生成失败');
        setState('error');
      }
    }, POLL_INTERVAL);
  }, [stopPolling, loadPaperRecords]);

  // cleanup on unmount
  useEffect(() => stopPolling, [stopPolling]);

  // 侧边栏"新项目"按钮 → 重置到 idle
  const tickRef = useRef(paperNewProjectTick);
  useEffect(() => {
    if (paperNewProjectTick !== tickRef.current) {
      tickRef.current = paperNewProjectTick;
      stopPolling();
      setState('idle');
      setStage('');
      setDetail('');
      setPdfUrl('');
      setActivePaperId(null);
      setErrorMessage('');
      setReviseInput('');
    }
  }, [paperNewProjectTick, stopPolling]);

  // 侧边栏点击 paper record
  useEffect(() => {
    if (!currentPaperId) return;
    const record = paperRecords.find(r => r.id === currentPaperId);
    if (!record) return;

    // 如果前端已经处于终态，不要因为 paperRecords 更新而重新触发
    if (state === 'completed' || state === 'error') {
      // 只在 paperId 真正变化时才处理（不是同一个 paper 的 records 刷新）
      if (activePaperId === currentPaperId) return;
    }

    if (record.status === 'planning_chat') {
      // 规划讨论中 — 保持 idle，PlanChat 通过 currentPaperId 自行恢复
      stopPolling();
      setState('idle');
      setErrorMessage('');
    } else if (record.status === 'completed' && record.pdf_url) {
      stopPolling();
      setPdfUrl(record.pdf_url);
      setActivePaperId(record.id);
      setState('completed');
      setErrorMessage('');
    } else if (TERMINAL_STATUSES.has(record.status)) {
      // failed
      stopPolling();
      setActivePaperId(record.id);
      setErrorMessage(record.error || '生成失败');
      setState('error');
    } else {
      // 进行中 — 接上轮询
      setActivePaperId(record.id);
      setStage(record.status);
      setDetail(record.progress_detail || '');
      setState('generating');
      startPolling(record.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPaperId]);

  const handleSubmit = useCallback(async (paperId: string, topic: string, designContext: string) => {
    setState('generating');
    setStage('pending');
    setDetail('提交中...');
    setPdfUrl('');
    setErrorMessage('');

    const authState = getAuthState();
    const userId = authState.user?.id || 'anonymous';

    const resultId = await generatePaper({
      topic,
      user_id: userId,
      design_context: designContext,
      paper_id: paperId,
    });
    if (!resultId) {
      setErrorMessage('提交失败');
      setState('error');
      return;
    }

    setActivePaperId(resultId);
    setCurrentPaperId(resultId);
    loadPaperRecords();
    startPolling(resultId);
  }, [loadPaperRecords, setCurrentPaperId, startPolling]);

  const handleRevise = useCallback(async () => {
    if (!activePaperId || !reviseInput.trim() || isRevising) return;

    setIsRevising(true);
    setState('revising');
    setStage('pending');
    setDetail('正在分析修改范围...');
    setErrorMessage('');

    const ok = await revisePaper(activePaperId, { instruction: reviseInput.trim() });
    if (!ok) {
      setErrorMessage('提交修改失败');
      setState('completed'); // 回到 completed 保留旧 PDF
      setIsRevising(false);
      return;
    }

    setReviseInput('');
    startPolling(activePaperId);
    // isRevising 会在轮询到终态时重置
  }, [activePaperId, reviseInput, isRevising, startPolling]);

  // 轮询到终态时重置 isRevising
  useEffect(() => {
    if (state === 'completed' || state === 'error') {
      setIsRevising(false);
    }
  }, [state]);

  const handleRetry = useCallback(async () => {
    if (!activePaperId) return;

    setState('generating');
    setStage('pending');
    setDetail('正在恢复...');
    setErrorMessage('');

    const ok = await retryPaper(activePaperId);
    if (!ok) {
      setErrorMessage('恢复失败，请重新生成');
      setState('error');
      return;
    }

    // 确保 currentPaperId 与 activePaperId 一致，防止侧边栏 effect 干扰
    setCurrentPaperId(activePaperId);
    startPolling(activePaperId);
  }, [activePaperId, startPolling, setCurrentPaperId]);

  const handleReset = useCallback(() => {
    stopPolling();
    setState('idle');
    setStage('');
    setDetail('');
    setPdfUrl('');
    setActivePaperId(null);
    setErrorMessage('');
    setReviseInput('');
    setCurrentPaperId(null);
  }, [setCurrentPaperId, stopPolling]);

  // 将后端 status 值映射到 ProgressView 的 stage key
  const progressStage = (() => {
    const map: Record<string, string> = {
      pending: 'researching',
      researching: 'researching',
      planning: 'planning',
      writing: 'writing',
      formatting: 'formatting',
      compiling: 'compiling',
    };
    return map[stage] || stage;
  })();

  /* ---- idle / generating / error: centered layout ---- */
  if (state !== 'completed') {
    return (
      <div className="flex flex-col h-screen pt-12">
        {state === 'idle' && (
          <div className="flex-1 min-h-0">
            <PlanChat
              key={paperNewProjectTick}
              onStartGenerate={handleSubmit}
              initialPaperId={currentPaperId}
            />
          </div>
        )}

        {(state === 'generating' || state === 'revising') && (
          <div className="flex-1 flex items-center justify-center p-6">
            <ProgressView stage={progressStage} detail={detail} />
          </div>
        )}

        {state === 'error' && (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="w-full max-w-2xl mx-auto">
              <ProgressView stage={progressStage} detail={detail} isError errorMessage={errorMessage} />
              <div className="flex items-center justify-center gap-3 mt-6">
                {activePaperId && (
                  <button
                    onClick={handleRetry}
                    className="px-6 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors duration-200 cursor-pointer"
                  >
                    从断点恢复
                  </button>
                )}
                <button
                  onClick={handleReset}
                  className="px-6 py-2 rounded-xl border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
                >
                  重新开始
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  /* ---- completed: full-screen PDF viewer + bottom revise bar ---- */
  return (
    <div className="flex flex-col h-screen pt-12 pb-2 px-3 gap-2">
      <div className="flex-1 min-h-0 rounded-2xl overflow-hidden border border-border">
        <PDFPreview
          pdfUrl={pdfUrl}
          proxyUrl={activePaperId ? getPaperPdfProxyUrl(activePaperId) : undefined}
        />
      </div>

      <div className="shrink-0 px-4 py-2.5 rounded-2xl border border-border bg-card">
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
    </div>
  );
}