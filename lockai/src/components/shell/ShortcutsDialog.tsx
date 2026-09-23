'use client';

import { Dialog } from '@/components/ui/Dialog';
import { modKey } from '@/lib/cn';

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mod = modKey();
  const groups: Array<{ title: string; rows: Array<[string, string[]]> }> = [
    {
      title: '全局',
      rows: [
        ['搜索 / 命令', [mod, 'K']],
        ['新对话', [mod, '⇧', 'O']],
        ['显示 / 收起侧栏', [mod, '⇧', 'S']],
        ['设置', [mod, ',']],
        ['快捷键', [mod, '/']],
      ],
    },
    {
      title: '对话',
      rows: [
        ['发送', ['Enter']],
        ['换行', ['⇧', 'Enter']],
        ['停止回答', ['Esc']],
        ['回答中：排队发送', ['Enter']],
        ['回答中：打断并发送', [mod, 'Enter']],
        ['编辑上一条问题', ['↑']],
        ['复制最后一条回答', [mod, '⇧', 'C']],
      ],
    },
  ];

  return (
    <Dialog open={open} onClose={onClose} title="快捷键" className="max-w-[440px]">
      <div className="space-y-5 px-6 pb-6 pt-3">
        {groups.map((group) => (
          <div key={group.title}>
            <div className="mb-2 text-[11.5px] font-medium text-fg-faint">{group.title}</div>
            <div className="space-y-1">
              {group.rows.map(([label, keys]) => (
                <div key={label} className="flex items-center justify-between py-1 text-[13.5px]">
                  <span className="text-fg-soft">{label}</span>
                  <span className="flex gap-1">
                    {keys.map((k) => (
                      <kbd
                        key={k}
                        className="min-w-[24px] rounded-md border border-line border-b-2 bg-surface px-1.5 py-0.5 text-center font-sans text-[11.5px] text-fg-soft"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
