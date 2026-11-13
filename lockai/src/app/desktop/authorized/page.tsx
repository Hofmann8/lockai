import { LockMark } from '@/components/brand/LockMark';

export default function DesktopAuthorizedPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <LockMark size={40} snapKey={1} className="text-fg" />
        <p className="text-[15px] text-fg">已登录 LockAI Desktop</p>
        <p className="text-[13px] text-fg-soft">可以关闭这个页面了。</p>
      </div>
    </div>
  );
}
