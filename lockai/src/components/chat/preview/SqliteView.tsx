'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Table2, Eye } from 'lucide-react';
import type { Database, SqlValue } from 'sql.js';
import type { FileArtifact } from '@/types';
import { cn } from '@/lib/cn';
import { DataGrid, formatCount, Opening, PreviewFallback, useFetched } from './shared';

const PAGE_ROWS = 500;

interface TableInfo {
  name: string;
  type: 'table' | 'view';
  rows: number;
}

interface Result {
  columns: string[];
  types?: string[];
  rows: string[][];
  total?: number;
  error?: string;
}

const cell = (v: SqlValue) => (v === null ? 'NULL' : v instanceof Uint8Array ? `<${v.byteLength} 字节>` : String(v));
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function run(db: Database, sql: string): Result {
  const [res] = db.exec(sql);
  if (!res) return { columns: [], rows: [] };
  return { columns: res.columns, rows: res.values.slice(0, PAGE_ROWS).map((r) => r.map(cell)), total: res.values.length };
}

/** SQLite：左边表和视图，右边数据；也能自己写只读的 SQL 查 */
export default function SqliteView({ file }: { file: FileArtifact }) {
  const { buffer, error } = useFetched(file.url, 'buffer');
  const dbRef = useRef<Database | null>(null);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [sql, setSql] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    (async () => {
      const { default: initSqlJs } = await import('sql.js');
      const SQL = await initSqlJs({ locateFile: () => '/sqljs/sql-wasm.wasm' });
      if (cancelled) return;
      const db = new SQL.Database(new Uint8Array(buffer));
      dbRef.current = db;
      const [res] = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name");
      const list: TableInfo[] = (res?.values ?? []).map(([name, type]) => {
        const [count] = db.exec(`SELECT COUNT(*) FROM ${quote(String(name))}`);
        return { name: String(name), type: type === 'view' ? 'view' : 'table', rows: Number(count?.values[0][0] ?? 0) };
      });
      setTables(list);
      if (list[0]) setActive(list[0].name);
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      dbRef.current?.close();
      dbRef.current = null;
    };
  }, [buffer]);

  useEffect(() => {
    const db = dbRef.current;
    if (!db || !active) return;
    try {
      const info = db.exec(`PRAGMA table_info(${quote(active)})`)[0];
      const types = info?.values.map((r) => String(r[2] || '').toLowerCase()) ?? [];
      const data = run(db, `SELECT * FROM ${quote(active)} LIMIT ${PAGE_ROWS}`);
      const total = tables?.find((t) => t.name === active)?.rows;
      setResult({ ...data, columns: data.columns.length ? data.columns : info?.values.map((r) => String(r[1])) ?? [], types, total });
      setSql(`SELECT * FROM ${quote(active)} LIMIT 100;`);
    } catch (e) {
      setResult({ columns: [], rows: [], error: (e as Error).message });
    }
  }, [active, tables]);

  if (error || failed) return <PreviewFallback file={file} note="数据库没能打开（可能不是 SQLite 文件），可以下载后用 DB Browser 打开" />;
  if (!tables) return <Opening label="正在打开数据库" />;
  if (tables.length === 0) return <PreviewFallback file={file} note="这个数据库里还没有表" />;

  const query = () => {
    const db = dbRef.current;
    if (!db || !sql.trim()) return;
    // 只读：不让改库（改了也只是改浏览器里这份）
    if (!/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
      setResult({ columns: [], rows: [], error: '这里只能查询（SELECT / WITH / PRAGMA）' });
      return;
    }
    setActive(null);
    try {
      setResult(run(db, sql));
    } catch (e) {
      setResult({ columns: [], rows: [], error: (e as Error).message });
    }
  };

  return (
    <div className="flex h-full">
      <aside className="flex w-48 shrink-0 flex-col border-r border-line bg-bg">
        <p className="px-3 pb-1.5 pt-3 text-[11px] font-medium tracking-wide text-fg-faint">表和视图</p>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {tables.map((t) => (
            <button
              key={t.name}
              type="button"
              onClick={() => setActive(t.name)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors',
                active === t.name ? 'bg-surface-2 text-fg' : 'text-fg-soft hover:bg-surface-2/60 hover:text-fg',
              )}
            >
              {t.type === 'view' ? <Eye className="h-3.5 w-3.5 shrink-0 text-fg-faint" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-fg-faint" />}
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <span className="text-[10.5px] tabular-nums text-fg-faint">{formatCount(t.rows)}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-start gap-2 border-b border-line bg-(--code-bg) px-3 py-2">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                query();
              }
            }}
            rows={Math.min(5, Math.max(1, sql.split('\n').length))}
            spellCheck={false}
            className="min-w-0 flex-1 resize-none bg-transparent py-1 font-mono text-[12.5px] leading-relaxed text-fg outline-none placeholder:text-fg-faint"
            placeholder="SELECT …"
          />
          <button
            type="button"
            onClick={query}
            title="运行（Ctrl + Enter）"
            className="flex h-7 shrink-0 items-center gap-1 rounded-lg bg-ink px-2.5 text-[12px] font-medium text-ink-fg transition-opacity hover:opacity-90"
          >
            <Play className="h-3 w-3" fill="currentColor" /> 运行
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {result?.error ? (
            <p className="m-4 rounded-xl bg-danger-soft px-3 py-2 font-mono text-[12px] text-danger">{result.error}</p>
          ) : result ? (
            <DataGrid columns={result.columns} types={result.types} rows={result.rows} total={result.total} meta={<span className="font-medium text-fg-soft">{active ?? '查询结果'}</span>} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
