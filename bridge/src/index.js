/**
 * FMP print bridge — runs on the always-on store PC.
 *
 * Connects OUTBOUND to the POS server over Socket.IO (no port-forwarding needed)
 * and executes print jobs:
 *   - kind "receipt": raw ESC/POS bytes to the Rongta
 *       mode "tcp":   sent to the printer's ethernet/wifi interface, port 9100
 *       mode "share": written to a temp file and copied raw to a shared
 *                     Windows printer (Rongta on USB, shared as e.g. "Rongta")
 *   - kind "label": Niimbot label printing (Phase 2)
 *
 * Configure via bridge/config.json (see config.example.json).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

const configPath = new URL('../config.json', import.meta.url);
if (!fs.existsSync(configPath)) {
  console.error('Missing bridge/config.json — copy config.example.json and fill it in.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const socket = io(config.serverUrl, { transports: ['websocket'] });

socket.on('connect', () => {
  console.log(`[bridge] connected to ${config.serverUrl}`);
  socket.emit('bridge-online', config.storeId);
});

socket.on('disconnect', (reason) => console.log(`[bridge] disconnected: ${reason} — retrying automatically`));

socket.on('print-job', async (job) => {
  try {
    if (job.kind === 'receipt') {
      const bytes = Buffer.from(job.escposBase64, 'base64');
      await printRaw(bytes);
      console.log(`[bridge] receipt printed (${bytes.length} bytes)`);
    } else if (job.kind === 'label') {
      console.log('[bridge] label jobs arrive in Phase 2 — ignoring for now');
    }
  } catch (err) {
    console.error('[bridge] print failed:', err.message);
  }
});

function printRaw(bytes) {
  const printer = config.receiptPrinter ?? {};
  if (printer.mode === 'tcp') {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: printer.host, port: printer.port ?? 9100 }, () => {
        sock.end(bytes, resolve);
      });
      sock.setTimeout(5000, () => {
        sock.destroy();
        reject(new Error('printer TCP timeout'));
      });
      sock.on('error', reject);
    });
  }
  if (printer.mode === 'share') {
    // raw copy to a shared printer: works for USB Rongta shared as \\localhost\<shareName>
    const tmp = path.join(os.tmpdir(), `fmp-receipt-${Date.now()}.bin`);
    fs.writeFileSync(tmp, bytes);
    return new Promise((resolve, reject) => {
      execFile('cmd.exe', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${printer.shareName}`], (err) => {
        fs.unlink(tmp, () => {});
        if (err) reject(err);
        else resolve();
      });
    });
  }
  return Promise.reject(new Error(`unknown receiptPrinter.mode "${printer.mode}" — use "tcp" or "share"`));
}
