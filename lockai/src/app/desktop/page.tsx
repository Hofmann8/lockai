import { LockMark } from '@/components/brand/LockMark';

// 安装包放在 nginx 的 /downloads/ 下，发新版时覆盖同名文件即可（见 README）
const INSTALLER_URL = '/downloads/LockAI-Desktop-Setup.exe';

export default function DesktopDownloadPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <LockMark size={40} snapKey={1} className="text-fg" />
        <p className="text-[15px] text-fg">LockAI Desktop</p>
        <p className="text-[13px] text-fg-soft">在电脑上用 Campbell 写代码、改文件。</p>
        <a
          href={INSTALLER_URL}
          download
          className="mt-2 flex h-11 items-center justify-center rounded-full bg-ink px-6 text-[14px] font-medium text-ink-fg shadow-float transition-[transform,box-shadow] duration-300 hover:shadow-pop active:scale-[0.98]"
        >
          下载 Windows 版
        </a>
      </div>
    </div>
  );
}
