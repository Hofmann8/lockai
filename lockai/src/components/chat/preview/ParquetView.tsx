'use client';

import { useEffect, useState } from 'react';
import type { FileArtifact } from '@/types';
import { DataGrid, Opening, PreviewFallback, useFetched } from './shared';

const PREVIEW_ROWS = 500;

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

/** Parquet（pandas / polars 常用的数据格式）：列名、列类型、前几百行 */
export default function ParquetView({ file }: { file: FileArtifact }) {
  const { buffer, error } = useFetched(file.url, 'buffer');
  const [data, setData] = useState<{ columns: string[]; types: string[]; rows: string[][]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!buffer) return;
    let cancelled = false;
    (async () => {
      const { parquetMetadata, parquetSchema, parquetReadObjects } = await import('hyparquet');
      const meta = parquetMetadata(buffer);
      const schema = parquetSchema(meta);
      const columns = schema.children.map((c) => c.element.name);
      const types = schema.children.map((c) => String(c.element.logical_type?.type ?? c.element.converted_type ?? c.element.type ?? '').toLowerCase());
      const objects = await parquetReadObjects({ file: buffer, rowEnd: Math.min(PREVIEW_ROWS, Number(meta.num_rows)) });
      if (cancelled) return;
      setData({ columns, types, rows: objects.map((o) => columns.map((c) => show(o[c]))), total: Number(meta.num_rows) });
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [buffer]);

  if (error || failed) return <PreviewFallback file={file} note="Parquet 文件没能解析出来（可能用了浏览器不支持的压缩方式），可以下载后用 pandas 打开" />;
  if (!data) return <Opening label="正在读取数据" />;
  return <DataGrid columns={data.columns} types={data.types} rows={data.rows} total={data.total} meta={<span className="font-medium text-fg-soft">Parquet</span>} />;
}
