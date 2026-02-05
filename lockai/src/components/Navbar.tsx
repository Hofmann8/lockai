'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { MessageSquare, FileText, Menu, X, LogOut, Settings } from 'lucide-react';
import { logout } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SettingsModal } from '@/components/SettingsModal';

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  {
    href: '/chat',
    label: 'Chat',
    icon: <MessageSquare className="h-5 w-5" />,
  },
  {
    href: '/paper',
    label: 'Paper',
    icon: <FileText className="h-5 w-5" />,
  },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleLogout = () => {
    logout();
    router.push('/');
  };

  const toggleMobileMenu = () => {
    setIsMobileMenuOpen(!isMobileMenuOpen);
  };

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <>
    <nav className="fixed top-4 left-4 right-4 z-50">
      <div className="mx-auto max-w-7xl">
        <div className="relative rounded-2xl border border-border bg-card/80 backdrop-blur-xl shadow-lg transition-colors duration-300">
          <div className="flex h-16 items-center justify-between px-4 sm:px-6">
            {/* Logo with theme-aware crossfade */}
            <Link 
              href="/chat" 
              className="flex items-center gap-3 cursor-pointer"
              onClick={closeMobileMenu}
            >
              <div className="relative w-8 h-8">
                <Image
                  src="https://funkandlove-main.s3.bitiful.net/public/icon-white.png"
                  alt="Funk&Love Logo"
                  width={32}
                  height={32}
                  className={`absolute inset-0 drop-shadow-md transition-opacity duration-500 ${resolvedTheme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
                />
                <Image
                  src="https://funkandlove-main.s3.bitiful.net/public/icon-black.png"
                  alt="Funk&Love Logo"
                  width={32}
                  height={32}
                  className={`absolute inset-0 drop-shadow-md transition-opacity duration-500 ${resolvedTheme === 'light' ? 'opacity-100' : 'opacity-0'}`}
                />
              </div>
              <span className="text-lg font-semibold text-foreground hidden sm:block">
                LockAI
              </span>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`
                      flex items-center gap-2 px-4 py-2 rounded-xl font-medium
                      transition-colors duration-200 cursor-pointer
                      ${isActive 
                        ? 'bg-primary text-primary-foreground' 
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      }
                    `}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>

            {/* Desktop Actions */}
            <div className="hidden md:flex items-center gap-2">
              <ThemeToggle />
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="flex items-center justify-center w-10 h-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
                aria-label="设置"
              >
                <Settings className="h-5 w-5" />
              </button>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 rounded-xl font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
              >
                <LogOut className="h-5 w-5" />
                <span>退出</span>
              </button>
            </div>

            {/* Mobile Menu Button */}
            <div className="md:hidden flex items-center gap-2">
              <ThemeToggle />
              <button
                onClick={toggleMobileMenu}
                className="flex items-center justify-center w-10 h-10 rounded-xl text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
                aria-label={isMobileMenuOpen ? '关闭菜单' : '打开菜单'}
              >
                {isMobileMenuOpen ? (
                  <X className="h-6 w-6" />
                ) : (
                  <Menu className="h-6 w-6" />
                )}
              </button>
            </div>
          </div>

          {/* Mobile Navigation Menu */}
          {isMobileMenuOpen && (
            <div className="md:hidden border-t border-border px-4 py-4 space-y-2 animate-slide-up">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={closeMobileMenu}
                    className={`
                      flex items-center gap-3 px-4 py-3 rounded-xl font-medium
                      transition-colors duration-200 cursor-pointer
                      ${isActive 
                        ? 'bg-primary text-primary-foreground' 
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                      }
                    `}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              
              {/* Mobile Logout Button */}
              <button
                onClick={() => {
                  closeMobileMenu();
                  setIsSettingsOpen(true);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
              >
                <Settings className="h-5 w-5" />
                <span>设置</span>
              </button>
              <button
                onClick={() => {
                  closeMobileMenu();
                  handleLogout();
                }}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors duration-200 cursor-pointer"
              >
                <LogOut className="h-5 w-5" />
                <span>退出登录</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
    <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
    </>
  );
}
