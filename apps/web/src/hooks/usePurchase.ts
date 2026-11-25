import { useCallback, useEffect, useState } from 'react';

import {
  PURCHASE_POLL_MS,
  PURCHASE_PROCESSING_LIMIT_MS,
  type UserPurchaseResponse,
} from '@flashsale/shared';

import type { SaleApi } from '../api';
import { msg, purchaseStateMessage, text, type Message } from '../messages';
import type { Purchase } from '../pageState';

// The user's purchase. Polled while processing, until the time limit; then `still_processing`.
export function usePurchase(api: SaleApi, userId: string, setMessage: (m: Message | null) => void) {
  const [purchase, setPurchase] = useState<Purchase>({ kind: 'none' });
  const [processingSince, setProcessingSince] = useState(0);

  // Show the state the server reports. `none` only announces itself when asked.
  const applyState = useCallback(
    (res: UserPurchaseResponse, opts: { announceNone?: boolean; prefix?: string } = {}) => {
      if (res.state === 'none') {
        if (opts.announceNone) setMessage(msg(`No purchase found for ${res.userId}.`));
        return;
      }
      if (res.state === 'processing') {
        setPurchase((prev) => (prev.kind === 'still_processing' ? prev : { kind: 'processing' }));
        setProcessingSince((since) => since || Date.now());
      } else {
        setPurchase(
          res.state === 'success' ? { kind: 'success' } : { kind: 'failed', reason: res.reason },
        );
        setProcessingSince(0); // the next processing purchase gets its own time limit
      }

      const m = purchaseStateMessage(res.state, res.reason);
      setMessage(opts.prefix ? msg(`${opts.prefix} ${m.text}`, m.tone) : m);
    },
    [setMessage],
  );

  const accepted = useCallback(() => {
    setProcessingSince(Date.now());
    setPurchase({ kind: 'processing' });
  }, []);

  const rejected = useCallback(() => setPurchase({ kind: 'rejected' }), []);

  const processing = purchase.kind === 'processing';
  useEffect(() => {
    if (!processing || !userId) return;
    const t = setInterval(async () => {
      if (Date.now() - processingSince >= PURCHASE_PROCESSING_LIMIT_MS) {
        setPurchase({ kind: 'still_processing' });
        setMessage(msg(text.stillProcessing));
        return;
      }
      try {
        const res = await api.getPurchase(userId);
        if (res.data) applyState(res.data);
      } catch {
        // retry on the next tick
      }
    }, PURCHASE_POLL_MS);
    return () => clearInterval(t);
  }, [api, processing, userId, processingSince, applyState, setMessage]);

  return { purchase, applyState, accepted, rejected };
}
