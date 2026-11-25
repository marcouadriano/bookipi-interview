import type {
  ApiErrorCode,
  FailureReason,
  SaleStatus,
  UserPurchaseResponse,
} from '@flashsale/shared';

import type { PageState } from './pageState';

export type Tone = 'neutral' | 'success' | 'error';
export interface Message {
  text: string;
  tone: Tone;
}

export const msg = (text: string, tone: Tone = 'neutral'): Message => ({
  text,
  tone,
});

export const text = {
  processing: 'Purchase is being processed…',
  success: 'Purchase successful. Your item is secured.',
  failedSoldOut: 'Sorry, it sold out before your purchase could be completed.',
  failedOther: "We couldn't complete your purchase. Please contact support.",
  stillProcessing: 'Your purchase is still being processed. Use Check my order in a moment.',
  alreadyPurchased: "You've already made a purchase. The limit is one per person.",
  soldOut: "Sorry, it's sold out.",
  notStarted: "The sale hasn't started yet.",
  ended: 'The sale has ended.',
  notAdmitted: 'Your buying time has ended. Rejoin the line to try again.',
  timesUp: "Time's up. Rejoin the line to try again.",
  invalidUserId:
    'Enter a valid email or username (letters, numbers, . _ @ + -, up to 64 characters).',
  rateLimited: 'Too many attempts. Please wait a moment and try again.',
  unavailable: 'Temporarily unavailable. Try again in a few seconds.',
  network: "Couldn't reach the server. Check your connection and try again.",
  internal: 'Something went wrong. Please try again.',
};

const errorMessages: Partial<Record<ApiErrorCode, Message>> = {
  invalid_user_id: msg(text.invalidUserId, 'error'),
  rate_limited: msg(text.rateLimited, 'error'),
  temporarily_unavailable: msg(text.unavailable),
};

export const codeMessage = (code: ApiErrorCode | undefined): Message =>
  (code && errorMessages[code]) || msg(text.internal, 'error');

const saleStatusMessages: Record<SaleStatus, Message> = {
  upcoming: msg(text.notStarted),
  active: msg(text.ended), // the server never rejects a purchase as "active"; only a stale refresh gets here
  ended: msg(text.ended),
  sold_out: msg(text.soldOut),
};

export const saleStatusMessage = (status: SaleStatus | undefined): Message =>
  saleStatusMessages[status ?? 'ended'];

export function purchaseStateMessage(
  state: UserPurchaseResponse['state'],
  reason?: FailureReason,
): Message {
  switch (state) {
    case 'processing':
      return msg(text.processing);
    case 'success':
      return msg(text.success, 'success');
    case 'failed':
      return reason === 'sold_out' ? msg(text.failedSoldOut) : msg(text.failedOther, 'error');
    default:
      return msg('');
  }
}

// An explicit message wins. Otherwise a finished sale
// says so on load, not only after a rejected Buy.
export function displayMessage(message: Message | null, pageState: PageState): Message | null {
  if (message) return message;
  return pageState === 'sold_out' || pageState === 'ended' ? saleStatusMessage(pageState) : null;
}
