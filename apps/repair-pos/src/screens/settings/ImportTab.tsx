import { useRef, useState } from 'react';
import { Button } from '@fmp/ui';
import { api } from '@fmp/pos-client';

/** The file produced from the old RepairStorePOS database dump (see the legacy transform script). */
interface LegacyPayload {
  version: 1;
  source?: string;
  customers: Array<{ key: string; name: string; phone?: string | null }>;
  tickets: Array<{ number: string; customerKey: string; status: string; paid?: unknown }>;
}

interface ImportResult {
  customersCreated: number;
  customersMatched: number;
  ticketsCreated: number;
  ticketsSkipped: number;
  skipped: string[];
}

const CHUNK = 150;

/**
 * Settings → Import from old app. A manager picks the legacy-import.json file; customers and
 * tickets go up in chunks so a slow connection never times out, and the server skips anything
 * already imported, so running it twice is harmless.
 */
export function ImportTab() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [payload, setPayload] = useState<LegacyPayload | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function pick(file: File | undefined) {
    setError('');
    setResult(null);
    setPayload(null);
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as LegacyPayload;
      if (parsed.version !== 1 || !Array.isArray(parsed.customers) || !Array.isArray(parsed.tickets)) {
        throw new Error('This is not a legacy import file. Expected legacy-import.json from the old database dump.');
      }
      setPayload(parsed);
      setFileName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the file');
    }
  }

  async function run() {
    if (!payload) return;
    setError('');
    setResult(null);
    const totals: ImportResult = { customersCreated: 0, customersMatched: 0, ticketsCreated: 0, ticketsSkipped: 0, skipped: [] };
    const customersByKey = new Map(payload.customers.map((c) => [c.key, c]));
    const chunks: LegacyPayload['tickets'][] = [];
    for (let i = 0; i < payload.tickets.length; i += CHUNK) chunks.push(payload.tickets.slice(i, i + CHUNK));
    if (chunks.length === 0) chunks.push([]);
    setProgress({ done: 0, total: chunks.length });
    try {
      for (let i = 0; i < chunks.length; i++) {
        const tickets = chunks[i] ?? [];
        // every chunk carries the customers it refers to; the first also carries customers with no tickets
        const keys = new Set(tickets.map((t) => t.customerKey));
        const customers = i === 0 ? payload.customers : payload.customers.filter((c) => keys.has(c.key));
        for (const k of keys) if (!customersByKey.has(k)) totals.skipped.push(`customer ${k} missing from file`);
        const r = await api<ImportResult>('/api/imports/legacy', {
          method: 'POST',
          body: JSON.stringify({ version: 1, source: payload.source, customers, tickets }),
        });
        totals.customersCreated += r.customersCreated;
        totals.customersMatched += r.customersMatched;
        totals.ticketsCreated += r.ticketsCreated;
        totals.ticketsSkipped += r.ticketsSkipped;
        totals.skipped.push(...r.skipped);
        setProgress({ done: i + 1, total: chunks.length });
      }
      setResult(totals);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setProgress(null);
    }
  }

  const paid = payload?.tickets.filter((t) => t.paid).length ?? 0;
  const byStatus = payload
    ? payload.tickets.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {})
    : {};

  return (
    <div style={{ maxWidth: 720 }}>
      <h2 style={{ margin: 0, font: '700 22px Inter, sans-serif' }}>Import from the old app</h2>
      <p style={{ color: 'var(--ink-3)', fontSize: 14.5, marginTop: 6 }}>
        Brings customers and repair tickets over from RepairStorePOS. Choose the <code>legacy-import.json</code> file made from the old
        database. Customers are matched by phone number, tickets keep their original numbers, and anything already imported is skipped,
        so it is safe to run again.
      </p>

      <div style={{ marginTop: 18, padding: 18, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--card)' }}>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="Legacy import file"
          onChange={(e) => void pick(e.target.files?.[0])}
          style={{ display: 'none' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={progress !== null}>
            <i className="bi bi-folder2-open" /> Choose file
          </Button>
          <span style={{ color: fileName ? 'var(--ink)' : 'var(--ink-4)', fontSize: 14.5 }}>{fileName || 'No file chosen'}</span>
        </div>

        {payload && (
          <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {[
              ['Customers', payload.customers.length],
              ['Tickets', payload.tickets.length],
              ['Marked paid', paid],
              ['Still open', byStatus.open ?? 0],
              ['Picked up', byStatus.picked_up ?? 0],
              ['Cancelled', byStatus.cancelled ?? 0],
            ].map(([label, n]) => (
              <div key={String(label)} style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--line-soft)' }}>
                <div style={{ font: '700 20px Inter, sans-serif' }}>{n}</div>
                <div style={{ color: 'var(--ink-3)', fontSize: 12.5 }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {payload && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button variant="primary" onClick={() => void run()} disabled={progress !== null}>
              {progress ? `Importing… ${progress.done} of ${progress.total}` : 'Import customers and tickets'}
            </Button>
            {payload.source && <span style={{ color: 'var(--ink-4)', fontSize: 12.5 }}>{payload.source}</span>}
          </div>
        )}

        {error && (
          <div role="alert" style={{ marginTop: 12, color: 'var(--red)', fontSize: 14 }}>
            <i className="bi bi-exclamation-circle" /> {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16, padding: '12px 14px', borderRadius: 12, background: 'var(--green-bg)', color: 'var(--green)', fontSize: 14.5 }}>
            <div style={{ fontWeight: 700 }}>
              <i className="bi bi-check2-circle" /> Import finished
            </div>
            <div style={{ color: 'var(--ink)', marginTop: 4 }}>
              {result.customersCreated} customers added, {result.customersMatched} already existed · {result.ticketsCreated} tickets added,{' '}
              {result.ticketsSkipped} already present or skipped
            </div>
            {result.skipped.length > 0 && (
              <details style={{ marginTop: 6, color: 'var(--ink-2)', fontSize: 13 }}>
                <summary>{result.skipped.length} notes</summary>
                {result.skipped.map((s, i) => (
                  <div key={i}>{s}</div>
                ))}
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
