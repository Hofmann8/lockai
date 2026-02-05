'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated } from '@/lib/auth';

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * AuthGuard component - protects routes from unauthenticated access
 * Redirects to login page if user is not authenticated
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthed, setIsAuthed] = useState(false);

  useEffect(() => {
    const checkAuth = () => {
      const authed = isAuthenticated();
      if (!authed) {
        router.push('/');
      } else {
        setIsAuthed(true);
      }
      setIsChecking(false);
    };

    checkAuth();
  }, [router]);

  // Show loading state while checking authentication
  if (isChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">验证身份中...</p>
        </div>
      </div>
    );
  }

  // Don't render children if not authenticated
  if (!isAuthed) {
    return null;
  }

  return <>{children}</>;
}
