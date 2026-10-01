'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';

type Account = {
  environment: string;
  displayName: string;
  appId: string | null;
  gatewayUrl: string | null;
  notifyUrl: string | null;
  returnUrl: string | null;
  status: string;
  appReady: boolean;
  privateKeyConfigured: boolean;
  publicKeyConfigured: boolean;
  lastVerifiedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastWebhookAt: string | null;
  lastWebhookStatus: string | null;
};

type Detail = {
  sandbox: Account;
  production: Account;
  gates: { realPaymentsEnabled: boolean; alipayProductionEnabled: boolean; alipayProductionTestEnabled?: boolean; sandboxOnly: boolean };
  readiness: { ready: boolean; blockers: string[] };
};

const EMPTY = { environment: 'SANDBOX', appId: '', gatewayUrl: 'https://openapi-sandbox.dl.alipay.com/gateway.do', notifyUrl: '', returnUrl: '', publicKey: '', privateKey: '' };

export default function AlipayProviderPage() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    api<Detail>('/admin/payment-providers/alipay').then((payload) => {
      setDetail(payload);
      setForm((current) => ({
        ...current,
        appId: payload.sandbox.appId ?? '',
        gatewayUrl: payload.sandbox.gatewayUrl ?? current.gatewayUrl,
        notifyUrl: payload.sandbox.notifyUrl ?? '',
        returnUrl: payload.sandbox.returnUrl ?? '',
        privateKey: '',
      }));
    }).catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setError('');
    try {
      await api('/admin/payment-providers/alipay', { method: 'POST', body: JSON.stringify({ ...form, environment: 'SANDBOX' }) });
      setMessage('沙箱配置已保存。私钥只保存在服务器加密存储中。');
      setForm((current) => ({ ...current, privateKey: '', publicKey: '' }));
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '保存失败');
    }
  }

  async function verify() {
    setError('');
    try {
      await api('/admin/payment-providers/alipay/verify', { method: 'POST', body: JSON.stringify({ environment: 'SANDBOX' }) });
      setMessage('沙箱配置已验证。');
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '验证失败');
    }
  }

  if (!detail) return <p className="text-sm text-zinc-500">{error || '加载中…'}</p>;
  return (
    <section className="space-y-4 text-sm">
      <Link className="underline" href="/admin/payment-providers">返回支付渠道</Link>
      <h2 className="text-xl font-semibold">支付宝</h2>
      <p>环境 {detail.sandbox.environment} · 状态 {detail.sandbox.status} · AppID {detail.sandbox.appId ?? '未配置'}</p>
      <p>签名配置 {detail.sandbox.privateKeyConfigured ? '应用私钥已加密保存' : '应用私钥未配置'} · 支付宝公钥 {detail.sandbox.publicKeyConfigured ? '已配置' : '未配置'}</p>
      <p>异步通知 {detail.sandbox.notifyUrl ?? '未配置'}</p>
      <p>最近验证 {detail.sandbox.lastVerifiedAt ? new Date(detail.sandbox.lastVerifiedAt).toLocaleString() : '还没有'}</p>
      <p>最近成功调用 {detail.sandbox.lastSuccessAt ? new Date(detail.sandbox.lastSuccessAt).toLocaleString() : '还没有'}</p>
      <p>最近错误 {detail.sandbox.lastErrorCode ?? '无'} · 最近通知 {detail.sandbox.lastWebhookStatus ?? '无'}</p>
      <p>真实支付 {detail.gates.realPaymentsEnabled ? '已打开' : '关闭'} · 生产支付宝 {detail.gates.alipayProductionEnabled ? '已打开' : '关闭'} · 生产小额联调 {detail.gates.alipayProductionTestEnabled ? '已打开' : '关闭'} · 仅沙箱 {detail.gates.sandboxOnly ? '是' : '否'}</p>
      <p>正式套餐不会因此开放真实扣款。生产小额联调只允许平台管理员、指定测试工作空间和 0.90 元联调套餐同时满足。</p>
      <p>生产就绪 {detail.readiness.ready ? '通过' : '未通过'}{detail.readiness.blockers.length ? `：${detail.readiness.blockers.join('；')}` : ''}</p>
      <div className="grid gap-3 rounded-lg border bg-white p-4">
        <label>AppID<input className="mt-1 w-full rounded border px-3 py-2" value={form.appId} onChange={(event) => setForm({ ...form, appId: event.target.value })} /></label>
        <label>沙箱网关<input className="mt-1 w-full rounded border px-3 py-2" value={form.gatewayUrl} onChange={(event) => setForm({ ...form, gatewayUrl: event.target.value })} /></label>
        <label>异步通知地址<input className="mt-1 w-full rounded border px-3 py-2" value={form.notifyUrl} onChange={(event) => setForm({ ...form, notifyUrl: event.target.value })} /></label>
        <label>前台返回地址<input className="mt-1 w-full rounded border px-3 py-2" value={form.returnUrl} onChange={(event) => setForm({ ...form, returnUrl: event.target.value })} /></label>
        <label>支付宝公钥<textarea className="mt-1 w-full rounded border px-3 py-2" value={form.publicKey} onChange={(event) => setForm({ ...form, publicKey: event.target.value })} /></label>
        <label>应用私钥（只写入，不回显）<textarea className="mt-1 w-full rounded border px-3 py-2" value={form.privateKey} onChange={(event) => setForm({ ...form, privateKey: event.target.value })} /></label>
        <div className="flex gap-2">
          <button className="rounded bg-zinc-900 px-3 py-1.5 text-white" type="button" onClick={() => void save()}>保存沙箱配置</button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void verify()}>验证配置</button>
        </div>
      </div>
      {message ? <p>{message}</p> : null}
      {error ? <p className="text-red-600">{error}</p> : null}
    </section>
  );
}
