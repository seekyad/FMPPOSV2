/**
 * Ordering for device models in pickers and catalog lists.
 *
 * iPhones sort by generation, then size/tier within the generation:
 *   iPhone 11, iPhone 11 Pro, iPhone 11 Pro Max, iPhone 12, iPhone 12 mini, iPhone 12 Pro, …
 * with base first, then mini / "e", Plus, Air, Pro, Pro Max. The X family is generation 10
 * (X, XR, XS, XS Max) and each SE lands after the generation it shipped alongside.
 * Everything else sorts naturally (numbers compared as numbers) so "Galaxy A12" precedes "Galaxy A13".
 */

const VARIANT_RANK: Array<[RegExp, number]> = [
  [/\bpro max\b/i, 5],
  [/\bpro\b/i, 4],
  [/\bair\b/i, 3],
  [/\bplus\b/i, 2],
  [/\bmini\b/i, 1],
  [/\bxs max\b/i, 3],
  [/\bxs\b/i, 2],
  [/\bxr\b/i, 1],
];

/** [generation, variant rank] for an iPhone name, or null when the name is not an iPhone. */
export function iphoneOrder(name: string): [number, number] | null {
  const m = /^iphone\s+(.+)$/i.exec(name.trim());
  if (!m) return null;
  const rest = m[1]!.trim();
  let rank = 0;
  for (const [re, r] of VARIANT_RANK) {
    if (re.test(rest)) {
      rank = r;
      break;
    }
  }
  if (/^se\b/i.test(rest)) {
    // SE (2016) sat with the 6S, SE (2020) with the 11, SE (2022) with the 13
    const y = /(\d{4})/.exec(rest);
    const year = y ? Number(y[1]) : 2016;
    const gen = year >= 2022 ? 13.5 : year >= 2020 ? 11.5 : 6.5;
    return [gen, 0];
  }
  const num = /^(\d+)([a-z]?)/i.exec(rest);
  if (num) {
    const gen = Number(num[1]);
    const suffix = num[2]!.toLowerCase();
    // 6S sorts after 6; 16e sits right after the 16, before the Plus
    const bump = suffix === 's' ? 0.5 : 0;
    return [gen + bump, suffix === 'e' ? 1 : rank];
  }
  if (/^x/i.test(rest)) return [10, rank];
  return [0, rank];
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Sort comparator for device models: brand, family, then the model order above. */
export function compareDeviceModels(
  a: { brand: string; family?: string | null; name: string },
  b: { brand: string; family?: string | null; name: string },
): number {
  const brand = natural(a.brand, b.brand);
  if (brand !== 0) return brand;
  const family = natural(a.family ?? '', b.family ?? '');
  if (family !== 0) return family;
  const ia = iphoneOrder(a.name);
  const ib = iphoneOrder(b.name);
  if (ia && ib) return ia[0] - ib[0] || ia[1] - ib[1] || natural(a.name, b.name);
  return natural(a.name, b.name);
}
