'use client';

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { Lock, ArrowRight, Monitor } from "lucide-react";
import { redirectToSSO, isAuthenticated } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setMounted(true);
    // 检测移动端：屏幕宽度 < 768px 或 UA 包含移动设备标识
    const checkMobile = () => {
      const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      const smallScreen = window.innerWidth < 768;
      setIsMobile(mobileUA || smallScreen);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (isAuthenticated()) {
      router.push('/chat');
    }
  }, [router]);

  const handleLogin = () => {
    setIsLoading(true);
    redirectToSSO();
  };

  if (!mounted) {
    return null;
  }

  return (
    <div className="relative min-h-screen bg-background overflow-hidden">
      <div className="absolute inset-0 overflow-hidden">
        <div className="login-orb login-orb-1" />
        <div className="login-orb login-orb-2" />
        <div className="login-orb login-orb-3" />
      </div>

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="login-particle"
            style={{
              left: `${15 + i * 15}%`,
              animationDelay: `${i * 0.8}s`,
              animationDuration: `${4 + i * 0.5}s`,
            }}
          />
        ))}
      </div>

      <div className="absolute inset-0 bg-[linear-gradient(var(--border)_1px,transparent_1px),linear-gradient(90deg,var(--border)_1px,transparent_1px)] bg-size-[4rem_4rem] opacity-30" />

      <main className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center space-y-4 animate-fade-in">
            <div className="relative group">
              <div className="absolute inset-0 rounded-full bg-primary/20 blur-2xl scale-150 opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
              <div className="relative w-20 h-20 login-logo-float">
                <Image
                  src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
                  alt="Funk&Love Logo"
                  width={80}
                  height={80}
                  className="drop-shadow-lg dark:hidden"
                  priority
                />
                <Image
                  src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
                  alt="Funk&Love Logo"
                  width={80}
                  height={80}
                  className="hidden dark:block drop-shadow-lg"
                  priority
                />
              </div>
            </div>
            <div className="text-center space-y-2">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">LockAI</h1>
              <p className="text-sm font-medium tracking-wide text-muted-foreground">Funk&Love AI Platform</p>
            </div>
          </div>

          {isMobile ? (
            <div className="relative group animate-fade-in-up">
              <div className="absolute -inset-px rounded-2xl bg-linear-to-r from-primary/50 via-accent/50 to-primary/50 opacity-0 group-hover:opacity-100 blur-sm transition-opacity duration-500" />
              
              <div className="relative rounded-2xl border border-border bg-card/60 backdrop-blur-2xl p-8 shadow-xl transition-all duration-300">
                <div className="absolute inset-0 rounded-2xl bg-linear-to-b from-primary/5 to-transparent pointer-events-none" />
                
                <div className="relative space-y-6">
                  <div className="text-center space-y-3">
                    <div className="relative inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 text-primary login-icon-pulse">
                      <Monitor className="h-6 w-6" />
                      <div className="absolute inset-0 rounded-2xl border-2 border-primary/20 login-ring-expand" />
                    </div>
                    <div className="space-y-2">
                      <h2 className="text-xl font-semibold text-foreground">请使用电脑访问</h2>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        LockAI 目前仅支持桌面端体验<br />
                        移动端适配正在路上，敬请期待 ✨
                      </p>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-border/50">
                    <p className="text-xs text-center text-muted-foreground/80">
                      在电脑浏览器中打开 ai.funk-and.love
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="relative group animate-fade-in-up">
              <div className="absolute -inset-px rounded-2xl bg-linear-to-r from-primary/50 via-accent/50 to-primary/50 opacity-0 group-hover:opacity-100 blur-sm transition-opacity duration-500" />
              
              <div className="relative rounded-2xl border border-border bg-card/60 backdrop-blur-2xl p-8 shadow-xl transition-all duration-300">
                <div className="absolute inset-0 rounded-2xl bg-linear-to-b from-primary/5 to-transparent pointer-events-none" />
                
                <div className="relative space-y-6">
                  <div className="text-center space-y-3">
                    <div className="relative inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 text-primary login-icon-pulse">
                      <Lock className="h-6 w-6" />
                      <div className="absolute inset-0 rounded-2xl border-2 border-primary/20 login-ring-expand" />
                    </div>
                    <div className="space-y-1">
                      <h2 className="text-xl font-semibold text-foreground">欢迎回来</h2>
                      <p className="text-sm text-muted-foreground">使用 LockAuth 登录以继续</p>
                    </div>
                  </div>

                  <button
                    onClick={handleLogin}
                    disabled={isLoading}
                    className="login-btn group/btn w-full relative flex items-center justify-center gap-2 h-12 rounded-xl bg-primary text-primary-foreground font-medium overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover/btn:translate-x-full transition-transform duration-700" />
                    
                    {isLoading ? (
                      <div className="h-5 w-5 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                    ) : (
                      <>
                        <span className="relative">LockAuth SSO 登录</span>
                        <ArrowRight className="relative h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
                      </>
                    )}
                  </button>

                  <p className="text-xs text-center text-muted-foreground/80">仅限 Funk&Love 舞队成员使用</p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="absolute bottom-6 text-xs text-muted-foreground/50 animate-fade-in delay-500">
          © 2025 Funk&Love · ZJU DFM
        </div>
      </main>
    </div>
  );
}
