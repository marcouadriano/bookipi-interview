import type {
  ApiErrorCode,
  PurchaseResponse,
  QueueStatusResponse,
  SaleStatusResponse,
  UserPurchaseResponse,
} from '@flashsale/shared';

export class NetworkError extends Error {}

// `data` is the JSON body on success or on a
// PurchaseResponse 4xx; `code` is set for an error shape.
export interface ApiResult<T> {
  status: number;
  data?: T;
  code?: ApiErrorCode;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError();
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // empty or non-JSON body
  }

  const code = (json as { error?: { code?: ApiErrorCode } } | null)?.error?.code;
  return code ? { status: res.status, code } : { status: res.status, data: json as T };
}

const id = (userId: string) => encodeURIComponent(userId);

export const saleApi = {
  getSale: () => call<SaleStatusResponse>('GET', '/api/sale'),
  joinQueue: (userId: string) => call<QueueStatusResponse>('POST', '/api/queue', { userId }),
  getQueue: (userId: string) => call<QueueStatusResponse>('GET', `/api/queue/${id(userId)}`),
  buy: (userId: string) => call<PurchaseResponse>('POST', '/api/purchase', { userId }),
  getPurchase: (userId: string) => call<UserPurchaseResponse>('GET', `/api/purchase/${id(userId)}`),
};

// What the hooks depend on. Swap in another implementation
// (real backend, test double) without touching them.
export type SaleApi = typeof saleApi;
