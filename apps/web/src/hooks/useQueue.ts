import { useEffect, useState } from 'react';

import { QUEUE_POLL_MS, type QueueStatusResponse } from '@flashsale/shared';

import type { SaleApi } from '../api';

// The user's place in the line. Polled while `active` and waiting, paused while the tab is hidden.
export function useQueue(api: SaleApi, userId: string, active: boolean) {
  const [queue, setQueue] = useState<QueueStatusResponse | null>(null);
  const waiting = active && queue?.state === 'waiting';

  useEffect(() => {
    if (!waiting || !userId) return;
    const t = setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await api.getQueue(userId);
        if (res.data) setQueue(res.data);
      } catch {
        // retry on the next tick
      }
    }, QUEUE_POLL_MS);
    return () => clearInterval(t);
  }, [api, waiting, userId]);

  return { queue, setQueue };
}
