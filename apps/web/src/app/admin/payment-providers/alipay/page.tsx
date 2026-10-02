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
  gates: {
    realPaymentsEnabled: boolean;
    alipayProductionEnabled: boolean;
    alipayProductionTestEnabled?: boolean;
    paymentTestRealEnabled?: boolean;
    sandboxOnly: boolean;
  };
  readiness: { ready: boolean; blockers: string[] };
};

const PROD_GATEWAY = 'https://openapi.alipay.com/gateway.do';
const SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipay.com/gateway.do';
const DEFAULT_NOTIFY = 'https://api-alpha.zsaos.com/api/v1/payments/webhooks/alipay';
const DEFAULT_RETURN = 'https://alpha.zsaos.com/billing/payment/return';

type FormState = {
  environment: 'SANDBOX' | 'PRODUCTION';
  appId: string;
  gatewayUrl: string;
  notifyUrl: string;
  returnUrl: string;
  publicKey: string;
  privateKey: string;
  appReady: boolean;
};

function accountForm(account: Account, environment: 'SANDBOX' | 'PRODUCTION'): FormState {
  return {
    environment,
    appId: account.appId ?? '',
    gatewayUrl:
      account.gatewayUrl ??
      (environment === 'PRODUCTION' ? PROD_GATEWAY : SANDBOX_GATEWAY),
    notifyUrl: account.notifyUrl ?? (environment === 'PRODUCTION' ? DEFAULT_NOTIFY : ''),
    returnUrl: account.returnUrl ?? (environment === 'PRODUCTION' ? DEFAULT_RETURN : ''),
    publicKey: '',
    privateKey: '',
    appReady: account.appReady,
  };
}

function AccountCard({ title, account }: { title: string; account: Account }) {
  return (
    <div className="rounded-lg border bg-white p-4 text-sm">
      <p className="font-semibold">{title}</p>
      <p>
        环境 <span className="font-medium">{account.environment}</span> · 状态 {account.status} · AppID{' '}
        {account.appId ? '已配置' : '未配置'}
      </p>
      <p>
        应用私钥 {account.privateKeyConfigured ? '已加密保存' : '未配置'} · 支付宝公钥{' '}
        {account.publicKeyConfigured ? '已配置' : '未配置'}
      </p>
      <p>网关 {account.gatewayUrl ?? '未配置'}</p>
      <p>异步通知 {account.notifyUrl ?? '未配置'}</p>
      <p>前台返回 {account.returnUrl ?? '未配置'}</p>
      <p>最近验证 {account.lastVerifiedAt ? new Date(account.lastVerifiedAt).toLocaleString() : '还没有'}</p>
      <p>最近错误 {account.lastErrorCode ?? '无'} · 最近通知 {account.lastWebhookStatus ?? '无'}</p>
    </div>
  );
}

export default function AlipayProviderPage() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<FormState>(accountForm({
    environment: 'PRODUCTION',
    displayName: '支付宝',
    appId: null,
    gatewayUrl: PROD_GATEWAY,
    notifyUrl: DEFAULT_NOTIFY,
    returnUrl: DEFAULT_RETURN,
    status: 'UNCONFIGURED',
    appReady: false,
    privateKeyConfigured: false,
    publicKeyConfigured: false,
    lastVerifiedAt: null,
    lastSuccessAt: null,
    lastErrorCode: null,
    lastWebhookAt: null,
    lastWebhookStatus: null,
  }, 'PRODUCTION'));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function load() {
    api<Detail>('/admin/payment-providers/alipay')
      .then((payload) => {
        setDetail(payload);
        setForm(accountForm(payload.production, 'PRODUCTION'));
      })
      .catch((reason) => setError(reason instanceof ApiError ? reason.message : '加载失败'));
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    setError('');
    try {
      const body = {
        environment: form.environment,
        displayName: form.environment === 'PRODUCTION' ? '支付宝生产' : '支付宝沙箱',
        appId: form.appId,
        gatewayUrl: form.gatewayUrl,
        notifyUrl: form.notifyUrl,
        returnUrl: form.returnUrl,
        publicKey: form.publicKey || undefined,
        privateKey: form.privateKey || undefined,
        appReady: form.appReady,
      };
      await api('/admin/payment-providers/alipay', { method: 'POST', body: JSON.stringify(body) });
      setMessage(`${form.environment === 'PRODUCTION' ? '生产' : '沙箱'}配置已保存。私钥只写入服务器加密存储，页面不会回显。`);
      setForm((current) => ({ ...current, privateKey: '', publicKey: '' }));
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '保存失败');
    }
  }

  async function verify() {
    setError('');
    try {
      await api('/admin/payment-providers/alipay/verify', {
        method: 'POST',
        body: JSON.stringify({ environment: form.environment }),
      });
      setMessage(`${form.environment === 'PRODUCTION' ? '生产' : '沙箱'}配置已验证。`);
      load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '验证失败');
    }
  }

  if (!detail) return <p className="text-sm text-zinc-500">{error || '加载中…'}</p>;

  return (
    <section className="space-y-4 text-sm">
      <Link className="underline" href="/admin/payment-providers">
        返回支付渠道
      </Link>
      <h2 className="text-xl font-semibold">支付宝</h2>
      <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
        M8-1A 需要配置 <strong>PRODUCTION</strong>。请勿把私钥发到聊天 / Git / Markdown。保存后私钥只存在服务器加密字段。
      </p>
      <p>
        Feature Gate：真实支付 {detail.gates.realPaymentsEnabled ? '已打开' : '关闭'} · 生产小额联调{' '}
        {detail.gates.paymentTestRealEnabled || detail.gates.alipayProductionTestEnabled ? '已打开' : '关闭'} ·
        仅沙箱 {detail.gates.sandboxOnly ? '是' : '否'}
      </p>
      <p>
        生产就绪 {detail.readiness.ready ? '通过' : '未通过'}
        {detail.readiness.blockers.length ? `：${detail.readiness.blockers.join('；')}` : ''}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <AccountCard title="SANDBOX（当前不用于 M8-1A）" account={detail.sandbox} />
        <AccountCard title="PRODUCTION（M8-1A 必填）" account={detail.production} />
      </div>

      <div className="grid gap-3 rounded-lg border bg-white p-4">
        <label>
          配置环境
          <select
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.environment}
            onChange={(event) => {
              const environment = event.target.value === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
              const source = environment === 'PRODUCTION' ? detail.production : detail.sandbox;
              setForm(accountForm(source, environment));
            }}
          >
            <option value="PRODUCTION">PRODUCTION（生产）</option>
            <option value="SANDBOX">SANDBOX（沙箱）</option>
          </select>
        </label>
        <label>
          AppID
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.appId}
            onChange={(event) => setForm({ ...form, appId: event.target.value })}
          />
        </label>
        <label>
          网关
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.gatewayUrl}
            onChange={(event) => setForm({ ...form, gatewayUrl: event.target.value })}
          />
        </label>
        <label>
          异步通知地址（Notify URL）
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.notifyUrl}
            onChange={(event) => setForm({ ...form, notifyUrl: event.target.value })}
          />
        </label>
        <label>
          前台返回地址（Return URL）
          <input
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.returnUrl}
            onChange={(event) => setForm({ ...form, returnUrl: event.target.value })}
          />
        </label>
        <label>
          支付宝公钥
          <textarea
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.publicKey}
            onChange={(event) => setForm({ ...form, publicKey: event.target.value })}
            placeholder={detail.production.publicKeyConfigured && form.environment === 'PRODUCTION' ? '已配置时可留空不改' : ''}
          />
        </label>
        <label>
          应用私钥（只写入，不回显）
          <textarea
            className="mt-1 w-full rounded border px-3 py-2"
            value={form.privateKey}
            onChange={(event) => setForm({ ...form, privateKey: event.target.value })}
            placeholder={
              (form.environment === 'PRODUCTION' ? detail.production : detail.sandbox).privateKeyConfigured
                ? '已加密保存时可留空不改'
                : '粘贴应用私钥，仅提交到服务器'
            }
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.appReady}
            onChange={(event) => setForm({ ...form, appReady: event.target.checked })}
          />
          支付宝应用已上线可用（appReady）
        </label>
        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-zinc-900 px-3 py-1.5 text-white" type="button" onClick={() => void save()}>
            保存{form.environment === 'PRODUCTION' ? '生产' : '沙箱'}配置
          </button>
          <button className="rounded border px-3 py-1.5" type="button" onClick={() => void verify()}>
            验证{form.environment === 'PRODUCTION' ? '生产' : '沙箱'}配置
          </button>
        </div>
      </div>
      {message ? <p className="text-emerald-700">{message}</p> : null}
      {error ? <p className="text-red-600">{error}</p> : null}
    </section>
  );
}
