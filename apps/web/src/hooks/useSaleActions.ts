import { useState } from 'react';

import { normalizeUserId, type QueueStatusResponse, type SaleStatus } from '@flashsale/shared';

import { NetworkError, type SaleApi } from '../api';
import { codeMessage, msg, saleStatusMessage, text, type Message } from '../messages';
import { buyOutcome, joinOutcome } from '../outcomes';
import { isLockedToActiveId, type PageState, type Purchase } from '../pageState';
import { saveUserId } from '../storage';
import type { usePurchase } from './usePurchase';

interface ActionContext {
  input: string;
  activeId: string;
  pageState: PageState;
  purchase: Purchase;
  setActiveId: (id: string) => void;
  setMessage: (m: Message | null) => void;
  setQueue: (queue: QueueStatusResponse) => void;
  refreshSale: () => Promise<SaleStatus | null>;
  applyState: ReturnType<typeof usePurchase>['applyState'];
  accepted: () => void;
  rejected: () => void;
}

export function useSaleActions(api: SaleApi, ctx: ActionContext) {
  const {
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
  } = ctx;
  const [busy, setBusy] = useState(false);

  // Runs a user action with the busy flag and the shared network-error message.
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      setMessage(msg(text.network, 'error'));
    } finally {
      setBusy(false);
    }
  };

  const validInput = (): string | null => {
    const id = normalizeUserId(input);
    if (!id) setMessage(msg(text.invalidUserId, 'error'));
    return id;
  };

  // Remember this ID as the one the line and purchase belong to.
  const adopt = (id: string) => {
    saveUserId(id);
    setActiveId(id);
  };

  const join = async () => {
    const id = validInput();
    if (!id) return;
    setMessage(null);
    await run(async () => {
      const outcome = joinOutcome(await api.joinQueue(id));
      switch (outcome.kind) {
        case 'queued':
          adopt(id);
          setQueue(outcome.queue);
          break;
        case 'already_purchased': {
          adopt(id);
          const p = await api.getPurchase(id);
          if (p.data) applyState(p.data, { prefix: text.alreadyPurchased });
          else setMessage(msg(text.alreadyPurchased));
          break;
        }
        case 'sale_not_active':
          setMessage(saleStatusMessage((await refreshSale()) ?? undefined));
          break;
        case 'failed':
          setMessage(outcome.message);
      }
    });
  };

  const buyNow = async () => {
    if (!activeId) return;
    setMessage(null);
    await run(async () => {
      const outcome = buyOutcome(await api.buy(activeId));
      switch (outcome.kind) {
        case 'accepted':
          accepted();
          setMessage(msg(text.processing));
          break;
        case 'already_purchased': {
          const p = await api.getPurchase(activeId);
          if (p.data && p.data.state !== 'none') {
            applyState(p.data, { prefix: text.alreadyPurchased });
          } else {
            rejected();
            setMessage(msg(text.alreadyPurchased));
          }
          break;
        }
        case 'rejected':
          rejected();
          setMessage(outcome.message);
          break;
        case 'not_admitted':
          setQueue({ userId: activeId, state: 'expired' });
          setMessage(msg(text.notAdmitted));
          break;
        case 'failed':
          setMessage(outcome.message);
      }
    });
  };

  const checkOrder = async () => {
    const id = isLockedToActiveId(pageState) ? activeId : validInput();
    if (!id) return;
    await run(async () => {
      const res = await api.getPurchase(id);
      if (!res.data) return setMessage(codeMessage(res.code));
      if (res.data.state === 'processing' && purchase.kind === 'still_processing') {
        return setMessage(msg(text.stillProcessing));
      }
      adopt(id);
      applyState(res.data, { announceNone: true });
    });
  };

  return { busy, join, buyNow, checkOrder };
}
