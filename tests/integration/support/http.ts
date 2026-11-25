export interface Reply {
  status: number;
  body: any;
  headers: Headers;
}

export async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    headers: res.headers,
  };
}
