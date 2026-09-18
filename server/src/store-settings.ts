import { z } from 'zod';

const flags = (keys: string[]) => z.object(Object.fromEntries(keys.map(key => [key, z.boolean().optional()])));
export const publicSettingsSchema = z.object({
  drawerFloatCents: z.number().int().min(0).max(100_000_000).optional(),
  tradein: z.object({
    conditionBp: z.object({ good: z.number().int().min(0).max(20000), fair: z.number().int().min(0).max(20000), broken: z.number().int().min(0).max(20000) }),
    creditBonusBp: z.number().int().min(0).max(10000),
  }).optional(),
  printing: z.object({ autoPrintReceipt: z.boolean().optional(), labelNote: z.string().max(1000).optional() }).optional(),
  print: z.object({
    receipt: flags(['store', 'customer', 'footer', 'terms', 'kickDrawer']).extend({ paper: z.union([z.literal(58), z.literal(80)]).optional(), termsText: z.string().max(2000).optional() }).optional(),
    tag: flags(['date', 'ticket', 'customer', 'phone', 'device', 'repair', 'passcode', 'notes', 'promise', 'barcode', 'price']).optional(),
    device: flags(['carrier', 'storage', 'condition', 'barcode', 'imei', 'price']).optional(),
    inventory: flags(['sku', 'barcode', 'price']).optional(),
  }).optional(),
});

export const settingsPatchSchema = publicSettingsSchema.extend({
  dejavoo: z.object({
    tpn: z.string().trim().max(100).optional(),
    authKey: z.string().trim().max(500).optional(),
    registerId: z.string().trim().max(100).optional(),
    clearAuthKey: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export function publicStore<T extends { settings: unknown }>(store: T, manager: boolean) {
  const raw = (store.settings ?? {}) as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  // Parse sections separately so legacy malformed settings cannot expose arbitrary keys or hide the whole store.
  for (const [key, rule] of Object.entries(publicSettingsSchema.shape)) {
    const parsed = rule.safeParse(raw[key]);
    if (parsed.success && parsed.data !== undefined) settings[key] = parsed.data;
  }
  const terminal = (raw.dejavoo ?? {}) as Record<string, unknown>;
  settings.dejavoo = {
    configured: Boolean(terminal.tpn && terminal.authKey),
    ...(manager ? { tpn: typeof terminal.tpn === 'string' ? terminal.tpn : '',
      registerId: typeof terminal.registerId === 'string' ? terminal.registerId : '', hasAuthKey: Boolean(terminal.authKey) } : {}),
  };
  return { ...store, settings };
}
