import bcrypt from 'bcryptjs';
import { and, count, eq } from 'drizzle-orm';
import type { Db } from './index';
import {
  customers,
  customerDevices,
  deviceModels,
  inventoryItems,
  repairTypes,
  services,
  serviceTiers,
  stores,
  tradeinPricebook,
  users,
} from './schema';

const REPAIR_CATEGORIES: Record<string, string[]> = {
  'Screen & Display': [
    'Cracked screen', 'Broken LCD / OLED', 'Touchscreen not responding', 'Ghost touch', 'Black screen',
    'Screen flickering', 'Dead pixels', 'Green/purple lines on display', 'Dim display', 'Display bleeding',
    'Screen lifting/separating',
  ],
  'Battery & Power': [
    'Battery replacement', 'Fast battery drain', 'Not charging', 'Random shutdowns', 'Swollen battery',
    'Power button repair', 'Boot loop', 'Dead on arrival diagnostics', 'Overheating', 'Slow charging',
  ],
  'Charging Port': [
    'Charging port replacement', 'Loose charging port', 'Liquid in port', 'Port cleaning',
    'Dock flex replacement', 'Wireless charging failure',
  ],
  'Water & Liquid': [
    'Water damage treatment', 'Liquid damage diagnostics', 'Corrosion cleaning', 'Board wash & inspect',
  ],
  Camera: [
    'Rear camera replacement', 'Front camera replacement', 'Camera lens glass', 'Blurry camera',
    'Camera app crashing', 'Flash not working', 'Focus failure', 'Camera shake',
  ],
  Audio: [
    'Earpiece speaker', 'Loudspeaker replacement', 'Microphone repair', 'Headphone jack',
    'No sound on calls', 'Distorted audio', 'Volume buttons',
  ],
  Connectivity: [
    'Wi-Fi not working', 'Bluetooth issues', 'No service / signal', 'SIM reader replacement',
    'GPS issues', 'NFC repair', 'Antenna repair',
  ],
  'Buttons & Hardware': [
    'Home button', 'Volume button repair', 'Mute switch', 'Vibration motor', 'Proximity sensor',
    'Face ID repair', 'Touch ID repair', 'Frame straightening', 'SIM tray replacement',
  ],
  Software: [
    'OS reinstall / restore', 'Data transfer', 'Data recovery', 'Virus / malware removal',
    'iCloud / account setup', 'Forgotten passcode service', 'App troubleshooting',
    'Software update failure', 'Factory reset', 'Backup service',
  ],
  Motherboard: [
    'Micro-soldering diagnostics', 'IC chip repair', 'Backlight repair', 'Touch IC repair',
    'Charging IC repair', 'Audio IC repair', 'No power board repair', 'Data recovery (board-level)',
  ],
  'Cosmetic / Misc': [
    'Back glass replacement', 'Housing replacement', 'Button covers', 'Deep cleaning',
    'Tempered glass install', 'Skin / wrap install',
  ],
  Tablet: ['Tablet screen replacement', 'Tablet battery', 'Tablet charging port', 'Tablet camera', 'Tablet speaker'],
  Smartwatch: ['Watch screen replacement', 'Watch battery', 'Watch crown repair', 'Watch sensor repair', 'Watch band service'],
  'Console / Other': [
    'Console HDMI port', 'Console cleaning', 'Controller repair', 'Laptop screen', 'Laptop battery', 'Laptop keyboard',
  ],
};

const DEVICE_MODELS: Array<[string, string, 'phone' | 'tablet' | 'watch' | 'laptop']> = [
  ['Apple', 'iPhone 15 Pro Max', 'phone'], ['Apple', 'iPhone 15 Pro', 'phone'], ['Apple', 'iPhone 15', 'phone'],
  ['Apple', 'iPhone 14 Pro', 'phone'], ['Apple', 'iPhone 14', 'phone'], ['Apple', 'iPhone 13', 'phone'],
  ['Apple', 'iPhone 13 mini', 'phone'], ['Apple', 'iPhone 12', 'phone'], ['Apple', 'iPhone 11', 'phone'],
  ['Apple', 'iPhone XR', 'phone'], ['Samsung', 'Galaxy S23', 'phone'], ['Samsung', 'Galaxy S22 Ultra', 'phone'],
  ['Samsung', 'Galaxy A54', 'phone'], ['Google', 'Pixel 8 Pro', 'phone'], ['Google', 'Pixel 7a', 'phone'],
  ['Apple', 'iPad Air 11"', 'tablet'], ['Apple', 'iPad 10th gen', 'tablet'],
  ['Apple', 'Apple Watch S8', 'watch'], ['Apple', 'MacBook Air M1', 'laptop'],
];

/** Idempotent: seeds only when the database is empty. */
export async function seedIfEmpty(db: Db) {
  const [row] = await db.select({ n: count() }).from(stores);
  if (row && row.n > 0) return false;

  const [store] = await db
    .insert(stores)
    .values({
      name: 'Cedar Park #3',
      address: '123 Main St, Cedar Park, TX',
      phone: '(512) 555-0100',
      taxRateBp: 600,
      receiptHeader: 'FMP — Phone Repair & Sales',
      receiptFooter: 'Thank you! 90-day warranty on repairs.',
    })
    .returning();
  if (!store) throw new Error('seed: store insert failed');

  const pin = (p: string) => bcrypt.hashSync(p, 8);
  await db.insert(users).values([
    { storeId: store.id, name: 'Mike K.', initials: 'MK', pinHash: pin('1234'), role: 'manager', isTechnician: true },
    { storeId: store.id, name: 'Sara R.', initials: 'SR', pinHash: pin('2345'), role: 'employee', isTechnician: true },
    { storeId: store.id, name: 'Deon T.', initials: 'DT', pinHash: pin('3456'), role: 'employee', isTechnician: true },
  ]);

  const modelRows = await db
    .insert(deviceModels)
    .values(DEVICE_MODELS.map(([brand, name, kind]) => ({ brand, name, kind })))
    .returning();

  const repairRows = await db
    .insert(repairTypes)
    .values(
      Object.entries(REPAIR_CATEGORIES).flatMap(([category, names]) =>
        names.map((name, i) => ({ category, name, sortOrder: i })),
      ),
    )
    .returning();

  // Service catalog v2: services with device groups and per-model price tiers.
  const SERVICE_SEED: Array<{
    category: string;
    name: string;
    deviceGroup: string;
    timeMinutes: number;
    timeLabel?: string;
    partsCostCents: number;
    basePriceCents: number;
    intakeNotes?: string;
    tiers?: Array<[string, number]>;
  }> = [
    {
      category: 'Screens', name: 'Screen replacement — iPhone', deviceGroup: 'iPhone 12–16', timeMinutes: 45,
      partsCostCents: 7800, basePriceCents: 18900,
      intakeNotes: 'Quote the tier price at intake and confirm the exact model from the IMEI. Water-exposed devices get a diagnostic first — never quote a flat repair.',
      tiers: [['iPhone 12 / 13', 18900], ['iPhone 14 / 15', 21900], ['iPhone 16 Pro Max', 28900]],
    },
    { category: 'Screens', name: 'Screen replacement — Samsung', deviceGroup: 'Galaxy S21–S24', timeMinutes: 60, partsCostCents: 9600, basePriceCents: 22900 },
    { category: 'Screens', name: 'Screen replacement — iPad', deviceGroup: 'iPad 8–10, Air', timeMinutes: 90, partsCostCents: 8400, basePriceCents: 21900 },
    { category: 'Batteries', name: 'Battery replacement — iPhone', deviceGroup: 'iPhone 11–16', timeMinutes: 30, partsCostCents: 2200, basePriceCents: 8900 },
    { category: 'Batteries', name: 'Battery replacement — Android', deviceGroup: 'Most Android', timeMinutes: 45, partsCostCents: 2600, basePriceCents: 9900 },
    { category: 'Charge ports', name: 'Charge port repair', deviceGroup: 'iPhone / Android', timeMinutes: 50, partsCostCents: 1800, basePriceCents: 10900 },
    { category: 'Charge ports', name: 'Charge port clean-out', deviceGroup: 'Any device', timeMinutes: 15, partsCostCents: 0, basePriceCents: 2900 },
    { category: 'Water damage', name: 'Water damage treatment', deviceGroup: 'Any device', timeMinutes: 1440, timeLabel: '24 hr hold', partsCostCents: 1200, basePriceCents: 12900 },
    { category: 'Water damage', name: 'Liquid damage diagnostic', deviceGroup: 'Any device', timeMinutes: 30, partsCostCents: 0, basePriceCents: 4500 },
    { category: 'Software', name: 'Data transfer & backup', deviceGroup: 'Any device', timeMinutes: 60, partsCostCents: 0, basePriceCents: 6900 },
    { category: 'Software', name: 'Software restore / unbrick', deviceGroup: 'iOS / Android', timeMinutes: 75, partsCostCents: 0, basePriceCents: 7900 },
    { category: 'Software', name: 'Passcode / account unlock', deviceGroup: 'Owner-verified', timeMinutes: 45, partsCostCents: 0, basePriceCents: 5900 },
    { category: 'Board level', name: 'Back glass replacement', deviceGroup: 'iPhone 8–16', timeMinutes: 120, timeLabel: '2 hr', partsCostCents: 3400, basePriceCents: 14900 },
    { category: 'Board level', name: 'Micro-soldering — board repair', deviceGroup: 'Bench only', timeMinutes: 180, timeLabel: '3 hr', partsCostCents: 2500, basePriceCents: 24900 },
  ];
  const serviceRows = await db
    .insert(services)
    .values(SERVICE_SEED.map(({ tiers, ...s }) => s))
    .returning();
  const tierValues = SERVICE_SEED.flatMap((s, i) =>
    (s.tiers ?? []).map(([label, priceCents], order) => ({
      serviceId: serviceRows[i]!.id,
      label,
      priceCents,
      sortOrder: order,
    })),
  );
  if (tierValues.length > 0) await db.insert(serviceTiers).values(tierValues);

  // Trade-in pricebook seed
  const pricebookSeed: Array<[string, string, number]> = [
    ['iPhone 13', '128 GB', 31000], ['iPhone 13', '256 GB', 34000], ['iPhone 12', '64 GB', 22000],
    ['iPhone 14 Pro', '128 GB', 52000], ['Galaxy S23', '256 GB', 38000], ['Pixel 8 Pro', '256 GB', 41000],
  ];
  await db.insert(tradeinPricebook).values(
    pricebookSeed.flatMap(([name, storage, base]) => {
      const m = modelRows.find((x) => x.name === name);
      return m ? [{ modelId: m.id, storage, baseValueCents: base }] : [];
    }),
  );

  const [dana] = await db
    .insert(customers)
    .values([
      { name: 'Dana Nguyen', phone: '(512) 555-0142', email: 'dana.n@email.com' },
      { name: 'Marcus Webb', phone: '(512) 555-0198' },
      { name: 'Ana Ruiz', phone: '(737) 555-0110', vip: true },
    ])
    .returning();
  if (dana) {
    const m15 = modelRows.find((x) => x.name === 'iPhone 15 Pro Max');
    await db.insert(customerDevices).values({
      customerId: dana.id,
      modelId: m15?.id,
      label: 'iPhone 15 Pro Max · 256 GB',
      imei: '359299240099214',
      detail: 'Natural Titanium',
    });
  }

  const find = (name: string) => modelRows.find((x) => x.name === name);
  await db.insert(inventoryItems).values([
    {
      storeId: store.id, kind: 'device', name: 'iPhone 15 Pro Max', modelId: find('iPhone 15 Pro Max')?.id,
      imei: '359299240099234', storage: '256 GB', conditionGrade: 'A', carrier: 'Unlocked',
      costCents: 72000, priceCents: 94900,
    },
    {
      storeId: store.id, kind: 'device', name: 'iPhone 13', modelId: find('iPhone 13')?.id,
      imei: '353912340073522', storage: '128 GB', conditionGrade: 'B', carrier: 'AT&T',
      costCents: 30000, priceCents: 42900,
    },
    { storeId: store.id, kind: 'accessory', name: 'Tempered glass protector', sku: 'ACC-TG-UNI', qty: 42, costCents: 300, priceCents: 1500 },
    { storeId: store.id, kind: 'accessory', name: 'USB-C cable 1m', sku: 'ACC-CBL-C1', qty: 30, costCents: 250, priceCents: 1200 },
    { storeId: store.id, kind: 'part', name: 'iPhone 13 OLED assembly', sku: 'PRT-13-OLED', qty: 6, costCents: 4500, priceCents: 0, taxable: false },
  ]);

  // Link the stocked OLED to the iPhone screen-replacement service so part consumption is live.
  const [oled] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.sku, 'PRT-13-OLED'));
  const screenService = serviceRows.find((s) => s.name === 'Screen replacement — iPhone');
  if (oled && screenService) {
    await db.update(services).set({ partItemId: oled.id }).where(eq(services.id, screenService.id));
  }

  return true;
}
