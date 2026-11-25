import { useCallback, useEffect, useState } from 'react';

import { SALE_POLL_MS, type SaleStatus, type SaleStatusResponse } from '@flashsale/shared';

import type { SaleApi } from '../api';
import { effectiveSaleStatus } from '../pageState';

// Sale status, polled (paused while the tab is hidden), plus the server-clock offset.
export function useSale(api: SaleApi) {
  const [sale, setSale] = useState<SaleStatusResponse | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Returns the status the server just reported, or null when the refresh failed.
  const refreshSale = useCallback(async (): Promise<SaleStatus | null> => {
    try {
      const res = await api.getSale();
      if (res.data) {
        setSale(res.data);
        setOffset(Date.parse(res.data.serverTime) - Date.now());
        return res.data.status;
      }
    } catch {
      // the next poll retries
    }
    return null;
  }, [api]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void refreshSale();
    const t = setInterval(() => {
      if (!document.hidden) void refreshSale();
    }, SALE_POLL_MS);
    return () => clearInterval(t);
  }, [refreshSale]);

  const serverNow = now + offset;
  return {
    sale,
    serverNow,
    saleStatus: effectiveSaleStatus(sale, serverNow),
    refreshSale,
  };
}
