/** Shared domain types used by both POS front-ends, the server, and the bridge. */

export type Role = 'employee' | 'manager';

export type SaleStatus = 'open' | 'parked' | 'completed' | 'voided' | 'refunded';
export type SaleLineKind = 'product' | 'repair' | 'custom' | 'tradein' | 'payout';
export type PaymentMethod = 'cash' | 'card' | 'tap' | 'store_credit';

export type TicketStatus =
  | 'intake'
  | 'in_progress'
  | 'waiting_part'
  | 'ready'
  | 'completed'
  | 'cancelled'
  | 'abandoned';

export type InventoryStatus = 'in_stock' | 'hold_repair' | 'needs_intake' | 'sold' | 'removed';
export type InventoryKind = 'device' | 'part' | 'accessory';
export type ConditionGrade = 'A' | 'B' | 'C';

export interface SessionUser {
  id: number;
  name: string;
  role: Role;
  storeId: number;
  terminalId: number;
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
}

/** Print jobs dispatched over Socket.IO to the store's print bridge. */
export type PrintJob =
  | { kind: 'receipt'; escpos: string; cashDrawerKick: boolean }
  | { kind: 'label'; template: 'ticket' | 'inventory'; fields: Record<string, string> };

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  intake: 'Intake',
  in_progress: 'In progress',
  waiting_part: 'Waiting on part',
  ready: 'Ready for pickup',
  completed: 'Completed',
  cancelled: 'Cancelled',
  abandoned: 'Abandoned',
};
