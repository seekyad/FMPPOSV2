/** Label printing lives in @fmp/pos-client so the shared Inventory screen can
 *  print too; this re-export keeps the old repair-pos import paths working. */
export {
  printTicketLabel,
  printDeviceLabel,
  printInventoryLabel,
  reprintLabelPayload,
  setLabelPrefs,
  TAG_DEFAULTS,
  DEVICE_LABEL_DEFAULTS,
  INVENTORY_LABEL_DEFAULTS,
  type TagPrefs,
  type DeviceLabelPrefs,
  type InventoryLabelPrefs,
  type LabelPrefs,
  type TicketLabelFields,
} from '@fmp/pos-client';
