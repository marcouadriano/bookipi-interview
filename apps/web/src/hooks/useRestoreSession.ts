import { useEffect } from 'react';

import { normalizeUserId, type QueueStatusResponse } from '@flashsale/shared';

import type { SaleApi } from '../api';
import { readSavedUserId } from '../storage';
import type { usePurchase } from './usePurchase';

// After a refresh, restore the saved ID. A purchase state takes priority over the queue state.
export function useRestoreSession(
  api: SaleApi,
  setActiveId: (id: string) => void,
  applyState: ReturnType<typeof usePurchase>['applyState'],
  setQueue: (queue: QueueStatusResponse) => void,
) {
  useEffect(() => {
    const id = normalizeUserId(readSavedUserId());
    if (!id) return;
    setActiveId(id);
    void (async () => {
      try {
        const p = await api.getPurchase(id);
        if (p.data && p.data.state !== 'none') return applyState(p.data);
        const q = await api.getQueue(id);
        if (q.data) setQueue(q.data);
      } catch {
        // the user can still act manually
      }
    })();
  }, [api, applyState, setActiveId, setQueue]);
}
