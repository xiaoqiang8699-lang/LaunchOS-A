'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Row = { id: string; amount: number; currency: string; status: string; workspace: { name: string } };

export default function AdminInvoicesPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    void api<Row[]>('/admin/invoices').then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows) return <p className="text-sm text-zinc-500">加载中…</p>;
  if (rows.length === 0) return <p className="text-sm text-zinc-500">还没有账单。支付未接入。</p>;
  return (
    <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
      {rows.map((row) => (
        <li key={row.id} className="px-4 py-3 text-sm">
          {row.workspace.name} · {row.amount} {row.currency} · {row.status}
        </li>
      ))}
    </ul>
  );
}
