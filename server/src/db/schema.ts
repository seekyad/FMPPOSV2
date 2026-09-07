import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ */
/* Stores, terminals, staff                                            */
/* ------------------------------------------------------------------ */

export const stores = pgTable('stores', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  address: text('address'),
  phone: text('phone'),
  taxRateBp: integer('tax_rate_bp').notNull().default(600),
  receiptHeader: text('receipt_header'),
  receiptFooter: text('receipt_footer'),
  timezone: text('timezone').notNull().default('America/Chicago'),
  /** JSON bag for store-scoped settings: tradein config, dejavoo creds, drawer float, thresholds */
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const terminals = pgTable('terminals', {
  id: serial('id').primaryKey(),
  storeId: integer('store_id').notNull().references(() => stores.id),
  name: text('name').notNull(),
  deviceToken: text('device_token').notNull().unique(),
  revoked: boolean('revoked').notNull().default(false),
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  storeId: integer('store_id').notNull().references(() => stores.id),
  name: text('name').notNull(),
  initials: text('initials').notNull(),
  pinHash: text('pin_hash').notNull(),
  role: text('role', { enum: ['employee', 'manager'] }).notNull().default('employee'),
  isTechnician: boolean('is_technician').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const timeEntries = pgTable(
  'time_entries',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').notNull().references(() => users.id),
    clockIn: timestamp('clock_in').notNull(),
    clockOut: timestamp('clock_out'),
    editedBy: integer('edited_by').references(() => users.id),
    editNote: text('edit_note'),
    flagged: boolean('flagged').notNull().default(false),
  },
  (t) => [index('time_entries_user_idx').on(t.userId, t.clockIn)],
);

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

export const customers = pgTable(
  'customers',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    note: text('note'),
    vip: boolean('vip').notNull().default(false),
    storeCreditCents: integer('store_credit_cents').notNull().default(0),
    mergedInto: integer('merged_into'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('customers_phone_idx').on(t.phone), index('customers_name_idx').on(t.name)],
);

export const customerDevices = pgTable('customer_devices', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  modelId: integer('model_id').references(() => deviceModels.id),
  label: text('label').notNull(),
  imei: text('imei'),
  detail: text('detail'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const storeCreditLedger = pgTable('store_credit_ledger', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  deltaCents: integer('delta_cents').notNull(),
  reason: text('reason').notNull(),
  saleId: integer('sale_id'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Catalog: device models, repair types, service catalog, pricebook    */
/* ------------------------------------------------------------------ */

export const deviceModels = pgTable('device_models', {
  id: serial('id').primaryKey(),
  brand: text('brand').notNull(),
  /** product line within the brand: iPhone, iPad, Galaxy S, Pixel… */
  family: text('family'),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['phone', 'tablet', 'watch', 'laptop', 'other'] }).notNull().default('phone'),
  releaseYear: integer('release_year'),
  active: boolean('active').notNull().default(true),
});

export const repairTypes = pgTable('repair_types', {
  id: serial('id').primaryKey(),
  category: text('category').notNull(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const serviceCatalog = pgTable(
  'service_catalog',
  {
    id: serial('id').primaryKey(),
    modelId: integer('model_id').notNull().references(() => deviceModels.id),
    repairTypeId: integer('repair_type_id').notNull().references(() => repairTypes.id),
    priceCents: integer('price_cents').notNull(),
    partCostCents: integer('part_cost_cents').notNull().default(0),
    laborCents: integer('labor_cents').notNull().default(0),
    warrantyDays: integer('warranty_days').notNull().default(90),
    turnaroundMinutes: integer('turnaround_minutes').notNull().default(120),
    /** optional link to a stocked part that gets consumed on completion */
    partItemId: integer('part_item_id'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('service_catalog_model_repair_idx').on(t.modelId, t.repairTypeId)],
);

/**
 * The service catalog (v2, matches the approved design): a service is defined
 * once with a device group and base price; optional per-model tiers override
 * the price ("iPhone 14 / 15 — $219").
 */
export const services = pgTable('services', {
  id: serial('id').primaryKey(),
  category: text('category').notNull(),
  name: text('name').notNull(),
  deviceGroup: text('device_group').notNull().default('Any device'),
  timeMinutes: integer('time_minutes').notNull().default(45),
  timeLabel: text('time_label'),
  partsCostCents: integer('parts_cost_cents').notNull().default(0),
  basePriceCents: integer('base_price_cents').notNull(),
  warrantyDays: integer('warranty_days').notNull().default(90),
  intakeNotes: text('intake_notes'),
  partItemId: integer('part_item_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const serviceTiers = pgTable('service_tiers', {
  id: serial('id').primaryKey(),
  serviceId: integer('service_id').notNull().references(() => services.id),
  label: text('label').notNull(),
  priceCents: integer('price_cents').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
});

export const tradeinPricebook = pgTable(
  'tradein_pricebook',
  {
    id: serial('id').primaryKey(),
    modelId: integer('model_id').notNull().references(() => deviceModels.id),
    storage: text('storage').notNull(),
    baseValueCents: integer('base_value_cents').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('tradein_pricebook_model_storage_idx').on(t.modelId, t.storage)],
);

/* ------------------------------------------------------------------ */
/* Inventory                                                           */
/* ------------------------------------------------------------------ */

export const inventoryItems = pgTable(
  'inventory_items',
  {
    id: serial('id').primaryKey(),
    storeId: integer('store_id').notNull().references(() => stores.id),
    kind: text('kind', { enum: ['device', 'part', 'accessory'] }).notNull(),
    name: text('name').notNull(),
    sku: text('sku'),
    modelId: integer('model_id').references(() => deviceModels.id),
    // serialized device fields
    imei: text('imei'),
    storage: text('storage'),
    conditionGrade: text('condition_grade', { enum: ['A', 'B', 'C'] }),
    carrier: text('carrier'),
    fromTradeIn: boolean('from_trade_in').notNull().default(false),
    // stocked item fields
    qty: integer('qty').notNull().default(1),
    costCents: integer('cost_cents').notNull().default(0),
    priceCents: integer('price_cents').notNull().default(0),
    taxable: boolean('taxable').notNull().default(true),
    status: text('status', {
      enum: ['in_stock', 'hold_repair', 'needs_intake', 'sold', 'removed'],
    })
      .notNull()
      .default('in_stock'),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    soldAt: timestamp('sold_at'),
  },
  (t) => [
    index('inventory_store_kind_idx').on(t.storeId, t.kind, t.status),
    index('inventory_imei_idx').on(t.imei),
  ],
);

export const inventoryMovements = pgTable('inventory_movements', {
  id: serial('id').primaryKey(),
  itemId: integer('item_id').notNull().references(() => inventoryItems.id),
  deltaQty: integer('delta_qty').notNull(),
  kind: text('kind', {
    enum: ['receive', 'sale', 'refund_restock', 'adjustment', 'repair_consume', 'repair_restore', 'removal'],
  }).notNull(),
  reason: text('reason'),
  refId: integer('ref_id'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const purchases = pgTable('purchases', {
  id: serial('id').primaryKey(),
  storeId: integer('store_id').notNull().references(() => stores.id),
  supplier: text('supplier').notNull(),
  note: text('note'),
  totalCostCents: integer('total_cost_cents').notNull().default(0),
  receivedBy: integer('received_by').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Sales & payments                                                    */
/* ------------------------------------------------------------------ */

export const sales = pgTable(
  'sales',
  {
    id: serial('id').primaryKey(),
    storeId: integer('store_id').notNull().references(() => stores.id),
    terminalId: integer('terminal_id').references(() => terminals.id),
    userId: integer('user_id').references(() => users.id),
    customerId: integer('customer_id').references(() => customers.id),
    ticketNumber: text('ticket_number').notNull(),
    status: text('status', { enum: ['open', 'parked', 'completed', 'voided', 'refunded'] })
      .notNull()
      .default('open'),
    parkedNote: text('parked_note'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    /** for refund sales: the original sale being refunded */
    refundOfSaleId: integer('refund_of_sale_id'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sales_store_status_idx').on(t.storeId, t.status),
    uniqueIndex('sales_ticket_number_idx').on(t.ticketNumber),
  ],
);

export const saleLines = pgTable('sale_lines', {
  id: serial('id').primaryKey(),
  saleId: integer('sale_id').notNull().references(() => sales.id),
  kind: text('kind', { enum: ['product', 'repair', 'custom', 'tradein', 'payout'] }).notNull(),
  description: text('description').notNull(),
  qty: integer('qty').notNull().default(1),
  unitCents: integer('unit_cents').notNull(),
  discountCents: integer('discount_cents').notNull().default(0),
  taxable: boolean('taxable').notNull().default(true),
  inventoryItemId: integer('inventory_item_id').references(() => inventoryItems.id),
  ticketLineId: integer('ticket_line_id'),
});

export const payments = pgTable('payments', {
  id: serial('id').primaryKey(),
  saleId: integer('sale_id').references(() => sales.id),
  ticketId: integer('ticket_id'),
  method: text('method', { enum: ['cash', 'card', 'tap', 'store_credit'] }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  tenderedCents: integer('tendered_cents'),
  changeCents: integer('change_cents'),
  dejavooRef: text('dejavoo_ref'),
  isDeposit: boolean('is_deposit').notNull().default(false),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Repairs                                                             */
/* ------------------------------------------------------------------ */

export const repairTickets = pgTable(
  'repair_tickets',
  {
    id: serial('id').primaryKey(),
    storeId: integer('store_id').notNull().references(() => stores.id),
    number: text('number').notNull(),
    customerId: integer('customer_id').notNull().references(() => customers.id),
    status: text('status', {
      enum: ['intake', 'in_progress', 'waiting_part', 'ready', 'completed', 'cancelled', 'abandoned'],
    })
      .notNull()
      .default('intake'),
    callFlag: boolean('call_flag').notNull().default(false),
    technicianId: integer('technician_id').references(() => users.id),
    promisedAt: timestamp('promised_at'),
    totalCents: integer('total_cents').notNull().default(0),
    /** warranty rework: the original ticket this one reworks for free */
    warrantyOfTicketId: integer('warranty_of_ticket_id'),
    intakeBy: integer('intake_by').references(() => users.id),
    notesForTech: text('notes_for_tech'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('tickets_store_status_idx').on(t.storeId, t.status),
    uniqueIndex('tickets_number_idx').on(t.number),
  ],
);

export const ticketDevices = pgTable('ticket_devices', {
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => repairTickets.id),
  modelId: integer('model_id').references(() => deviceModels.id),
  label: text('label').notNull(),
  imei: text('imei'),
  powersOn: boolean('powers_on').notNull().default(true),
  unlockMethod: text('unlock_method', { enum: ['passcode', 'password', 'pattern', 'none'] }),
  unlockValue: text('unlock_value'),
  conditionNotes: text('condition_notes'),
});

export const ticketLines = pgTable('ticket_lines', {
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => repairTickets.id),
  ticketDeviceId: integer('ticket_device_id').references(() => ticketDevices.id),
  serviceCatalogId: integer('service_catalog_id').references(() => serviceCatalog.id),
  serviceId: integer('service_id').references(() => services.id),
  tierLabel: text('tier_label'),
  description: text('description').notNull(),
  priceCents: integer('price_cents').notNull(),
  warrantyDays: integer('warranty_days').notNull().default(90),
  partConsumed: boolean('part_consumed').notNull().default(false),
});

export const ticketStatusHistory = pgTable('ticket_status_history', {
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => repairTickets.id),
  status: text('status').notNull(),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Cash management                                                     */
/* ------------------------------------------------------------------ */

export const drawerSessions = pgTable('drawer_sessions', {
  id: serial('id').primaryKey(),
  storeId: integer('store_id').notNull().references(() => stores.id),
  openingFloatCents: integer('opening_float_cents').notNull(),
  openedBy: integer('opened_by').references(() => users.id),
  openedAt: timestamp('opened_at').notNull().defaultNow(),
  countedCents: integer('counted_cents'),
  expectedCents: integer('expected_cents'),
  closedBy: integer('closed_by').references(() => users.id),
  closedAt: timestamp('closed_at'),
});

export const cashMovements = pgTable('cash_movements', {
  id: serial('id').primaryKey(),
  drawerSessionId: integer('drawer_session_id').notNull().references(() => drawerSessions.id),
  kind: text('kind', { enum: ['paid_in', 'paid_out', 'tradein_payout', 'no_sale_open', 'drop'] }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  reason: text('reason'),
  userId: integer('user_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/* ------------------------------------------------------------------ */
/* Retail / carrier POS                                                */
/* ------------------------------------------------------------------ */

export const activations = pgTable(
  'activations',
  {
    id: serial('id').primaryKey(),
    storeId: integer('store_id').notNull().references(() => stores.id),
    customerId: integer('customer_id').notNull().references(() => customers.id),
    kind: text('kind', { enum: ['new_line', 'upgrade', 'port_in', 'wifi_box', 'tablet'] }).notNull(),
    carrier: text('carrier').notNull(),
    planName: text('plan_name'),
    accountNumber: text('account_number'),
    phoneNumber: text('phone_number'),
    monthlyCents: integer('monthly_cents').notNull().default(0),
    deviceItemId: integer('device_item_id').references(() => inventoryItems.id),
    saleId: integer('sale_id').references(() => sales.id),
    status: text('status', { enum: ['active', 'pending', 'cancelled'] }).notNull().default('active'),
    notes: text('notes'),
    userId: integer('user_id').references(() => users.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('activations_store_idx').on(t.storeId, t.createdAt)],
);

export const billPayments = pgTable(
  'bill_payments',
  {
    id: serial('id').primaryKey(),
    storeId: integer('store_id').notNull().references(() => stores.id),
    customerId: integer('customer_id').references(() => customers.id),
    carrier: text('carrier').notNull(),
    accountNumber: text('account_number').notNull(),
    amountCents: integer('amount_cents').notNull(),
    feeCents: integer('fee_cents').notNull().default(0),
    saleId: integer('sale_id').references(() => sales.id),
    userId: integer('user_id').references(() => users.id),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('bill_payments_store_idx').on(t.storeId, t.createdAt)],
);

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    storeId: integer('store_id').references(() => stores.id),
    userId: integer('user_id').references(() => users.id),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: integer('entity_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('audit_store_action_idx').on(t.storeId, t.action, t.createdAt)],
);
