export const int = (name: string, fallback: number, min = -Infinity) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  if (n < min) throw new Error(`${name} must be at least ${min}, got ${n}`);
  return n;
};
