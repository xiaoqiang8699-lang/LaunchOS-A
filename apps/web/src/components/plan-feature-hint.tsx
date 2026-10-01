'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export function PlanFeatureHint({ feature }: { feature: string }) {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api<{ show: boolean; message: string | null }>(`/account/subscription/feature-hint?feature=${feature}`)
      .then((result) => setMessage(result.show ? result.message : null))
      .catch(() => setMessage(null));
  }, [feature]);

  if (!message) return null;
  return <p className="text-sm text-amber-700">{message}</p>;
}
