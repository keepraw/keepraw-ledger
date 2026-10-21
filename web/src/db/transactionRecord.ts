/** Compatibility boundary: retain every other property without mutating caller input. */
export function withoutLegacyMerchant<T extends object>(value: T): Omit<T, 'merchant'> {
  if (!Object.hasOwn(value, 'merchant')) return value
  const cleaned = { ...value } as T & { merchant?: unknown }
  delete cleaned.merchant
  return cleaned
}
