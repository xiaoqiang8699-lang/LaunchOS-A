'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Section, Card } from '@/components/ui/section';

type Controls = {
  REAL_PAYMENTS_ENABLED: boolean;
  PAYMENT_TEST_REAL_ENABLED: boolean;
  ALIPAY_PRODUCTION_TEST_ENABLED: boolean;
  ALIPAY_SANDBOX_ONLY: boolean;
  ALIPAY_PROVIDER_MODE: string;
  sandboxOnlySemantics: { legacyMeaning: string; recommendation: string };
  accessMode: string;
  percentage: number;
  allowlistCount: number;
  killSwitch: { blocksNewCheckout: boolean; existingFinalizationContinues: boolean };
  provider: {
    configured: boolean;
    status: string;
    environment: string;
    livePaymentValidated: boolean;
  };
  termsVersion: string;
  checklist: {
    items: Array<{ key: string; label: string; pass: boolean }>;
    formalPaymentLaunchReady: boolean;
    formalPlanPaymentOpened: false;
  };
  warning: string;
  openConfirmRequiredPhrase: string;
};

export default function PaymentControlsPage() {
  const [data, setData] = useState<Controls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState('DISABLED');
  const [pct, setPct] = useState(0);
  const [phrase, setPhrase] = useState('');

  function reload() {
    api<Controls>('/admin/commercial/payment-controls')
      .then((d) => {
        setData(d);
        setMode(d.accessMode);
        setPct(d.percentage);
      })
      .catch((e: Error) => setError(e.message));
  }

  useEffect(() => {
    reload();
  }, []);

  async function saveAccess() {
    setError(null);
    try {
      await api('/admin/commercial/payment-controls/access', {
        method: 'POST',
        body: JSON.stringify({
          accessMode: mode,
          percentage: pct,
          confirmPhrase: mode === 'DISABLED' ? undefined : '配置支付灰度',
        }),
      });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="正式支付控制"
        description="Kill Switch / 灰度 / Provider 就绪。M8-3 保持正式收费关闭，禁止真正开启 REAL_PAYMENTS。"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {!data ? (
        <p className="text-sm text-zinc-500">加载中…</p>
      ) : (
        <>
          <Section title="Gate 状态">
            <Card className="space-y-1 p-4 font-mono text-xs">
              <p>REAL_PAYMENTS_ENABLED={String(data.REAL_PAYMENTS_ENABLED)}</p>
              <p>PAYMENT_TEST_REAL_ENABLED={String(data.PAYMENT_TEST_REAL_ENABLED)}</p>
              <p>ALIPAY_PRODUCTION_TEST_ENABLED={String(data.ALIPAY_PRODUCTION_TEST_ENABLED)}</p>
              <p>ALIPAY_SANDBOX_ONLY={String(data.ALIPAY_SANDBOX_ONLY)}</p>
              <p>ALIPAY_PROVIDER_MODE={data.ALIPAY_PROVIDER_MODE}</p>
              <p className="pt-2 font-sans text-sm text-zinc-600">{data.sandboxOnlySemantics.legacyMeaning}</p>
              <p className="font-sans text-sm text-zinc-600">{data.sandboxOnlySemantics.recommendation}</p>
            </Card>
          </Section>
          <Section title="Provider">
            <Card className="space-y-1 p-4 text-sm">
              <p>Environment: {data.provider.environment}</p>
              <p>Status: {data.provider.status}</p>
              <p>Configured: {String(data.provider.configured)}</p>
              <p>LIVE_PAYMENT_VALIDATED: {String(data.provider.livePaymentValidated)}</p>
              <p>Kill switch blocks new checkout: {String(data.killSwitch.blocksNewCheckout)}</p>
              <p>Existing payment finalization continues: {String(data.killSwitch.existingFinalizationContinues)}</p>
            </Card>
          </Section>
          <Section title="Payment Access（默认 DISABLED）">
            <Card className="space-y-3 p-4 text-sm">
              <p>Allowlist count: {data.allowlistCount}</p>
              <label className="block">
                Mode
                <select className="ml-2 rounded border px-2 py-1" value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="DISABLED">DISABLED</option>
                  <option value="ALLOWLIST">ALLOWLIST</option>
                  <option value="PERCENTAGE">PERCENTAGE</option>
                  <option value="ALL">ALL</option>
                </select>
              </label>
              <label className="block">
                Percentage
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="ml-2 w-20 rounded border px-2 py-1"
                  value={pct}
                  onChange={(e) => setPct(Number(e.target.value))}
                />
              </label>
              {mode !== 'DISABLED' ? (
                <label className="block">
                  确认词（配置支付灰度）
                  <input className="ml-2 rounded border px-2 py-1" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
                </label>
              ) : null}
              <button type="button" className="rounded bg-zinc-900 px-3 py-1.5 text-white" onClick={() => void saveAccess()}>
                保存灰度（不会开启 REAL_PAYMENTS）
              </button>
              <p className="text-amber-800">{data.warning}</p>
              <p className="text-zinc-500">开启正式收费确认词预留：{data.openConfirmRequiredPhrase}（本阶段不可执行）</p>
            </Card>
          </Section>
          <Section title="Launch Checklist">
            <Card className="space-y-1 p-4 text-sm">
              {data.checklist.items.map((item) => (
                <p key={item.key}>
                  {item.pass ? 'PASS' : 'FAIL'} — {item.label}
                </p>
              ))}
              <p className="pt-2 font-semibold">
                M8_FORMAL_PAYMENT_LAUNCH_READINESS={String(data.checklist.formalPaymentLaunchReady)}
              </p>
              <p>FORMAL_PLAN_PAYMENT_OPENED={String(data.checklist.formalPlanPaymentOpened)}</p>
              <p>Terms: {data.termsVersion}</p>
            </Card>
          </Section>
        </>
      )}
    </div>
  );
}
