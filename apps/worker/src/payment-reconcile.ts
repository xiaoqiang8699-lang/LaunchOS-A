import type { PrismaClient } from '@launchos/database';
import { reconcilePayments } from '@launchos/domain';
import { AlipayPaymentProvider } from '@launchos/providers';
import { decryptCredential } from '@launchos/shared';

const RECONCILE_MS = 60_000;

export function startPaymentReconciliation(prisma: PrismaClient): () => void {
  const tick = () => {
    void reconcilePayments(prisma, new Date(), async (payment) => {
      if (payment.provider !== 'ALIPAY' || !payment.merchantOrderNo || !payment.environment) return null;
      const account = await prisma.paymentProviderAccount.findUnique({ where: { provider_environment: { provider: 'ALIPAY', environment: payment.environment } } });
      if (!account?.appId || !account.gatewayUrl || !account.publicKey || !account.credentialEncrypted || !account.notifyUrl || !account.returnUrl) return null;
      let privateKey = '';
      try {
        privateKey = decryptCredential(account.credentialEncrypted);
        const provider = new AlipayPaymentProvider({
          appId: account.appId,
          gatewayUrl: account.gatewayUrl,
          privateKey,
          alipayPublicKey: account.publicKey,
          notifyUrl: account.notifyUrl,
          returnUrl: account.returnUrl,
        });
        const result = await provider.getCheckoutStatus(payment.merchantOrderNo);
        if (result.state === 'UNKNOWN_PENDING') return result;
        return { ...result, appId: account.appId, eventId: `trade-query:${payment.merchantOrderNo}:${result.state}` };
      } catch {
        return { state: 'UNKNOWN_PENDING' as const };
      } finally {
        privateKey = '';
      }
    }).catch((error) => {
      console.error('payment reconcile failed', error instanceof Error ? error.message : error);
    });
  };
  tick();
  const timer = setInterval(tick, RECONCILE_MS);
  return () => clearInterval(timer);
}
