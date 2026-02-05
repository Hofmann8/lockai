'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { handleSSOCallback } from '@/lib/auth';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';

function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('正在验证登录...');

  useEffect(() => {
    const result = handleSSOCallback(searchParams);
    
    if (result) {
      setStatus('success');
      setMessage('登录成功，正在跳转...');
      setTimeout(() => {
        router.push('/chat');
      }, 500);
    } else {
      setStatus('error');
      setMessage('登录失败，请重试');
      setTimeout(() => {
        router.push('/');
      }, 2000);
    }
  }, [searchParams, router]);

  return (
    <div className="text-center space-y-4">
      {status === 'loading' && (
        <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
      )}
      {status === 'success' && (
        <CheckCircle className="w-12 h-12 text-green-500 mx-auto" />
      )}
      {status === 'error' && (
        <XCircle className="w-12 h-12 text-destructive mx-auto" />
      )}
      <p className="text-foreground text-lg">{message}</p>
    </div>
  );
}

// 完全跳过 SSR，避免水合问题
const CallbackContentNoSSR = dynamic(() => Promise.resolve(CallbackContent), {
  ssr: false,
  loading: () => (
    <div className="text-center space-y-4">
      <Loader2 className="w-12 h-12 text-primary animate-spin mx-auto" />
      <p className="text-foreground text-lg">正在验证登录...</p>
    </div>
  ),
});

export default function CallbackPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <CallbackContentNoSSR />
    </div>
  );
}
