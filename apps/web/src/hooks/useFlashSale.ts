import { useEffect, useState } from 'react';

import { normalizeUserId } from '@flashsale/shared';

import { saleApi, type SaleApi } from '../api';
import { formatCountdown, saleCountdown } from '../format';
import { displayMessage, msg, text, type Message } from '../messages';
import { derivePageState, isIdLocked } from '../pageState';
import { readSavedUserId } from '../storage';
import { usePurchase } from './usePurchase';
import { useQueue } from './useQueue';
import { useRestoreSession } from './useRestoreSession';
import { useSale } from './useSale';
import { useSaleActions } from './useSaleActions';

export function useFlashSale(api: SaleApi = saleApi) {
  const [input, setInput] = useState(readSavedUserId);
  const [activeId, setActiveId] = useState(''); // the user ID the line and purchase belong to
  const [message, setMessage] = useState<Message | null>(null);

  const { sale, serverNow, saleStatus, refreshSale } = useSale(api);
  const { purchase, applyState, accepted, rejected } = usePurchase(api, activeId, setMessage);
  const { queue, setQueue } = useQueue(
    api,
    activeId,
    purchase.kind === 'none' && saleStatus === 'active',
  );

  const pageState = derivePageState(saleStatus, purchase, queue, serverNow);

  useRestoreSession(api, setActiveId, applyState, setQueue);

  // Buying window ran out: tell the user (not_admitted sets its own message).
  useEffect(() => {
    if (pageState === 'expired') setMessage((m) => m ?? msg(text.timesUp));
  }, [pageState]);

  const { busy, join, buyNow, checkOrder } = useSaleActions(api, {
    input,
    activeId,
    pageState,
    purchase,
    setActiveId,
    setMessage,
    setQueue,
    refreshSale,
    applyState,
    accepted,
    rejected,
  });

  const windowLeft =
    pageState === 'admitted' && queue?.admittedUntil
      ? formatCountdown(Date.parse(queue.admittedUntil) - serverNow)
      : '';

  return {
    pageState,
    saleStatus,
    countdown: saleCountdown(sale, saleStatus, serverNow),
    windowLeft,
    queue,
    message: displayMessage(message, pageState),
    busy,
    input,
    setInput,
    idLocked: isIdLocked(pageState),
    canJoin: saleStatus === 'active' && normalizeUserId(input) !== null,
    join,
    buyNow,
    checkOrder,
  };
}
