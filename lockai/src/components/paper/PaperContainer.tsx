'use client';

import { useState, useRef } from 'react';
import { FileCode, FileText } from 'lucide-react';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';
import { TextSelectionMenu } from './TextSelectionMenu';
import { AiAssistPanel } from './AiAssistPanel';
import { Sidebar } from '@/components/chat/Sidebar';
import { SettingsModal } from '@/components/SettingsModal';
import type { AiAssistAction } from './TextSelectionMenu';

type TabType = 'latex' | 'pdf';

const DEFAULT_LATEX = `E = mc^2

$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$

行内公式: $\\alpha + \\beta = \\gamma$

$\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$`;

export function PaperContainer() {
  const [activeTab, setActiveTab] = useState<TabType>('latex');
  const [latexContent, setLatexContent] = useState(DEFAULT_LATEX);
  const [aiPanelState, setAiPanelState] = useState<{
    isOpen: boolean;
    selectedText: string;
    action: AiAssistAction;
  }>({ isOpen: false, selectedText: '', action: 'explain' });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const previewContainerRef = useRef<HTMLDivElement>(null);

  const handleAiAction = (text: string, action: AiAssistAction) => {
    setAiPanelState({ isOpen: true, selectedText: text, action });
  };

  const handleCloseAiPanel = () => {
    setAiPanelState(prev => ({ ...prev, isOpen: false }));
  };

  const tabs: { id: TabType; label: string; icon: typeof FileCode }[] = [
    { id: 'latex', label: 'LaTeX', icon: FileCode },
    { id: 'pdf', label: 'PDF', icon: FileText },
  ];

  return (
    <>
      <Sidebar
        sessions={[]}
        paperRecords={[]}
        currentSessionId={null}
        onSelectSession={() => {}}
        onNewChat={() => {}}
        onDeleteSession={() => {}}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div
        className={`
          flex flex-col h-screen transition-all duration-300
          ${sidebarCollapsed ? 'ml-16' : 'ml-72'}
        `}
      >
        {/* Header */}
        <div className="px-4 pt-4">
          <div className="text-lg font-semibold text-foreground">LockAI</div>
          <div className="mt-2 mb-4">
            <h1 className="text-xl font-medium text-foreground">Paper Module</h1>
            <p className="text-sm text-muted-foreground">LaTeX 实时渲染 · PDF 阅读 · AI 辅助</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-4">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex cursor-pointer items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'latex' && (
            <div
              className={`grid h-full gap-4 p-4 transition-all duration-300 ${
                aiPanelState.isOpen ? 'grid-cols-1 lg:grid-cols-3' : 'grid-cols-1 lg:grid-cols-2'
              }`}
            >
              <div className="overflow-hidden rounded-lg border border-border transition-shadow duration-200 hover:shadow-md">
                <LatexEditor value={latexContent} onChange={setLatexContent} />
              </div>
              <div ref={previewContainerRef} className="overflow-hidden rounded-lg border border-border transition-shadow duration-200 hover:shadow-md">
                <LatexPreview content={latexContent} />
                <TextSelectionMenu onAction={handleAiAction} containerRef={previewContainerRef} />
              </div>
              {aiPanelState.isOpen && (
                <div className="overflow-hidden rounded-lg border border-border animate-fade-in">
                  <AiAssistPanel
                    selectedText={aiPanelState.selectedText}
                    action={aiPanelState.action}
                    onClose={handleCloseAiPanel}
                  />
                </div>
              )}
            </div>
          )}

          {activeTab === 'pdf' && (
            <div
              className={`grid h-full gap-4 p-4 ${
                aiPanelState.isOpen ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
              }`}
            >
              <div className="flex items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 transition-colors duration-200 hover:bg-muted/30">
                <div className="text-center">
                  <FileText className="mx-auto h-12 w-12 text-muted-foreground/50" />
                  <p className="mt-4 text-lg font-medium text-muted-foreground">PDF 阅读器</p>
                  <p className="mt-1 text-sm text-muted-foreground/70">即将推出 - 上传 PDF 文件进行阅读和 AI 辅助</p>
                </div>
              </div>
              {aiPanelState.isOpen && (
                <div className="overflow-hidden rounded-lg border border-border animate-fade-in">
                  <AiAssistPanel
                    selectedText={aiPanelState.selectedText}
                    action={aiPanelState.action}
                    onClose={handleCloseAiPanel}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
}
