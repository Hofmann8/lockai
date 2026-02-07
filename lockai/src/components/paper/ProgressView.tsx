'use client';

import { Search, BookOpen, PenTool, FileCode, FileText, CheckCircle, Loader2, AlertCircle } from 'lucide-react';

const STAGES = [
  { key: 'researching', label: '文献检索', icon: Search },
  { key: 'planning', label: '结构规划', icon: BookOpen },
  { key: 'writing', label: '内容撰写', icon: PenTool },
  { key: 'formatting', label: 'LaTeX 排版', icon: FileCode },
  { key: 'compiling', label: '编译 PDF', icon: FileText },
] as const;

type StageKey = (typeof STAGES)[number]['key'];

interface ProgressViewProps {
  stage: string;
  detail: string;
  isComplete?: boolean;
  isError?: boolean;
  errorMessage?: string;
}

export function ProgressView({
  stage,
  detail,
  isComplete = false,
  isError = false,
  errorMessage,
}: ProgressViewProps) {
  const currentIndex = STAGES.findIndex((s) => s.key === stage);

  function getStageStatus(index: number): 'completed' | 'active' | 'pending' {
    if (isComplete) return 'completed';
    if (isError && index === currentIndex) return 'active';
    if (index < currentIndex) return 'completed';
    if (index === currentIndex) return 'active';
    return 'pending';
  }

  // Calculate progress percentage
  const progressPercent = isComplete
    ? 100
    : currentIndex >= 0
      ? ((currentIndex + 0.5) / STAGES.length) * 100
      : 0;

  return (
    <div className="w-full max-w-2xl mx-auto animate-fade-in">
      {/* Title */}
      <div className="text-center mb-8">
        <h2 className="text-lg font-semibold text-foreground mb-1">
          {isComplete ? '论文生成完成' : isError ? '生成出错' : '正在生成论文...'}
        </h2>
        <p className="text-sm text-muted-foreground">{detail}</p>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1.5 rounded-full bg-muted mb-8 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${
            isError ? 'bg-destructive' : isComplete ? 'bg-green-500' : 'bg-primary'
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Stage indicators */}
      <div className="flex items-start justify-between gap-2">
        {STAGES.map((s, index) => {
          const status = getStageStatus(index);
          const Icon = s.icon;

          return (
            <div key={s.key} className="flex flex-col items-center gap-2 flex-1 min-w-0">
              {/* Icon circle */}
              <div
                className={`
                  w-10 h-10 rounded-xl flex items-center justify-center
                  transition-all duration-300
                  ${
                    status === 'completed'
                      ? 'bg-green-500/10 text-green-500'
                      : status === 'active'
                        ? isError
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground/50'
                  }
                `}
              >
                {status === 'completed' ? (
                  <CheckCircle className="w-5 h-5" />
                ) : status === 'active' && !isError ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : status === 'active' && isError ? (
                  <AlertCircle className="w-5 h-5" />
                ) : (
                  <Icon className="w-5 h-5" />
                )}
              </div>

              {/* Label */}
              <span
                className={`
                  text-xs text-center leading-tight
                  transition-colors duration-200
                  ${
                    status === 'completed'
                      ? 'text-green-500 font-medium'
                      : status === 'active'
                        ? isError
                          ? 'text-destructive font-medium'
                          : 'text-primary font-medium'
                        : 'text-muted-foreground/50'
                  }
                `}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Error message */}
      {isError && errorMessage && (
        <div className="mt-6 p-4 rounded-xl bg-destructive/5 border border-destructive/20 animate-fade-in">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive mb-1">生成失败</p>
              <p className="text-sm text-muted-foreground">{errorMessage}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
