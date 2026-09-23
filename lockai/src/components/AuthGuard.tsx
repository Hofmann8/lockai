'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated, onAuthStateChange } from '@/lib/auth';
import { LockMark } from '@/components/brand/LockMark';

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
      setIsAuthed(authed);
      if (!authed) {
        router.push('/');
      }
      setIsChecking(false);
    };

    checkAuth();
    const unsubscribe = onAuthStateChange(() => {
      const authed = isAuthenticated();
      setIsAuthed(authed);
      if (!authed) {
        router.push('/');
      }
    });

    return unsubscribe;
  }, [router]);

  // Show loading state while checking authentication
  if (isChecking) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <LockMark size={32} state="busy" className="text-fg" />
      </div>
    );
  }

  // Don't render children if not authenticated
  if (!isAuthed) {
    return null;
  }

  return <>{children}</>;
}
