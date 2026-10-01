'use client';

import { useState } from 'react';

export default function CheckoutDemoPage() {
  const [notice, setNotice] = useState('');

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto max-w-lg space-y-4">
        <p className="text-sm font-medium text-amber-800">Demo 支付页面</p>
        <h1 className="text-2xl font-semibold text-zinc-900">确认套餐支付</h1>
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          支付宝支付开通审核中。当前不会扣款。
        </p>
        <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-5 text-sm text-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900">LaunchOS Pro</h2>
          <p>计费周期：月付</p>
          <p>套餐费用：99 CNY / 月</p>
          <p>预计云资源费用：不包含在本次支付中</p>
          <p className="text-base font-medium text-zinc-900">本次应付：99 CNY</p>
          <p>支付方式：支付宝</p>
          <button
            className="mt-2 w-full rounded-lg bg-zinc-900 px-3 py-2 text-white"
            type="button"
            onClick={() => setNotice('支付宝支付开通审核中，当前不会扣款。')}
          >
            支付宝支付
          </button>
          {notice ? <p className="text-amber-800">{notice}</p> : null}
        </section>
        <p className="text-sm text-zinc-500">
          套餐费用不包含实际云资源费用。云资源费用根据你使用的服务器、数据库等另行产生。
        </p>
      </div>
    </main>
  );
}
