/** Narrow `T | null | undefined` to `T`, failing with a message instead of a non-null assertion. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}
