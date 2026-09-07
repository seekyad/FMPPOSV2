/**
 * Dejavoo SPIn semi-integrated payments.
 *
 * The POS sends only the amount; the terminal handles card entry, EMV, and
 * receipt. Configure per store in Settings → payments:
 *   settings.dejavoo = { tpn: string, authKey: string, registerId: string }
 *
 * Uses the SPIn Proxy REST endpoint. Validate against your terminal before
 * relying on it in production — SPIn deployments vary by processor; the
 * request shape below follows Dejavoo's published v2 JSON API.
 */

export interface DejavooConfig {
  tpn: string;
  authKey: string;
  registerId: string;
  /** override for self-hosted SPIn proxy; default is Dejavoo's cloud */
  baseUrl?: string;
}

export interface DejavooResult {
  approved: boolean;
  refId: string;
  responseMessage: string;
  raw: unknown;
}

export async function chargeDejavoo(
  config: DejavooConfig,
  amountCents: number,
  refId: string,
  paymentType: 'Credit' | 'Debit' = 'Credit',
): Promise<DejavooResult> {
  const base = config.baseUrl ?? 'https://spinpos.net/spin';
  const body = {
    Amount: (amountCents / 100).toFixed(2),
    PaymentType: paymentType,
    TransactionType: 'Sale',
    RefId: refId,
    PrintReceipt: 'No',
    GetReceipt: 'No',
    CaptureSignature: false,
    GetExtendedData: true,
    Tpn: config.tpn,
    Authkey: config.authKey,
    RegisterId: config.registerId,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000); // card prompts take a while
  try {
    const res = await fetch(`${base}/v2/Payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      GeneralResponse?: { ResultCode?: string; Message?: string };
    };
    const resultCode = data.GeneralResponse?.ResultCode;
    return {
      approved: resultCode === '0',
      refId,
      responseMessage: data.GeneralResponse?.Message ?? `HTTP ${res.status}`,
      raw: data,
    };
  } finally {
    clearTimeout(timeout);
  }
}
