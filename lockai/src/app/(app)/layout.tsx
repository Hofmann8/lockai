'use client';

import { AuthGuard } from '@/components/AuthGuard';
import { AppShell } from '@/components/AppShell';

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background transition-colors duration-300">
        <AppShell>{children}</AppShell>
      </div>
    </AuthGuard>
  );
}
