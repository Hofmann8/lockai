'use client';

import { FileText, Sparkles, Search, PenTool, BookOpen, CheckCircle } from 'lucide-react';

export default function PaperPage() {
  const steps = [
    { icon: Search, label: '文献检索' },
    { icon: BookOpen, label: '智能阅读' },
    { icon: PenTool, label: '内容生成' },
    { icon: CheckCircle, label: '论文成稿' },
  ];

  return (
    <div className="flex flex-col h-screen pt-12">
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="max-w-2xl w-full text-center">
          {/* Icon */}
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 text-primary mb-8 animate-fade-in">
            <FileText className="w-10 h-10" />
          </div>

          {/* Title */}
          <h1 className="text-2xl font-bold text-foreground mb-3 animate-fade-in">
            一句话，完成论文
          </h1>
          <p className="text-muted-foreground mb-8 animate-fade-in">
            输入研究主题，AI 自动完成文献检索、阅读理解、内容撰写，一键生成完整学术论文
          </p>

          {/* Flow Steps */}
          <div className="flex items-center justify-center gap-2 mb-10 animate-fade-in-up">
            {steps.map((step, index) => {
              const Icon = step.icon;
              return (
                <div key={step.label} className="flex items-center">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-xl bg-card border border-border flex items-center justify-center text-muted-foreground">
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className="text-xs text-muted-foreground">{step.label}</span>
                  </div>
                  {index < steps.length - 1 && (
                    <div className="w-8 h-px bg-border mx-2 mb-6" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Coming Soon Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-accent/10 text-accent text-sm font-medium animate-fade-in">
            <Sparkles className="w-4 h-4" />
            即将推出
          </div>

          {/* Footer */}
          <p className="text-sm text-muted-foreground mt-8 animate-fade-in">
            我们正在努力开发中，敬请期待 ✨
          </p>

          {/* Disclaimer */}
          <div className="mt-6 space-y-1 animate-fade-in">
            <p className="text-xs text-muted-foreground/70">
              LockAI 可能会出错，请核实重要信息
            </p>
            <p className="text-xs text-muted-foreground/70">
              仅供日常课程作业的辅助参考，不可用于正式学术发表
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
