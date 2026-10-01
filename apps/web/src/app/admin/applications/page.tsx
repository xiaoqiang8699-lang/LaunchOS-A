'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Row = { id: string; name: string; status: string; workspace: string; createdAt: string };

export default function AdminApplicationsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    void api<Row[]>('/admin/applications').then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows) return <p className="text-sm text-zinc-500">加载中…</p>;
  return (
    <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
      {rows.map((row) => (
        <li key={row.id} className="px-4 py-3 text-sm">
          {row.name} · {row.workspace} · {row.status}
        </li>
      ))}
    </ul>
  );
}
