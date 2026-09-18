/**
 * FMP print bridge — runs on the always-on store PC.
 *
 * Connects OUTBOUND to the POS server over Socket.IO (no port-forwarding needed)
 * and executes print jobs:
 *   - kind "receipt": raw ESC/POS bytes to the Rongta
 *       mode "tcp":     sent to the printer's ethernet/wifi interface, port 9100
 *       mode "windows": raw bytes into a Windows printer queue (USB printer installed on this PC)
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io } from 'socket.io-client';

const configPath = new URL('../config.json', import.meta.url);
if (!fs.existsSync(configPath)) {
  console.error('Missing bridge/config.json — copy config.example.json and fill it in.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.deviceToken) throw new Error('Pair this bridge first: npm run pair -w bridge');
const serverUrl = new URL(config.serverUrl);
if (serverUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname)) {
  throw new Error('Remote print bridge connections require HTTPS');
}
const socket = io(config.serverUrl, { transports: ['websocket'], auth: { kind: 'bridge', deviceToken: config.deviceToken } });
socket.on('connect_error', () => console.error('[bridge] connection or authorization failed — check pairing and server availability'));

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
      await printLabel(job.html);
      console.log(`[bridge] label printed — ${job.name}`);
    }
    if (job.jobId) socket.emit('print-result', { jobId: job.jobId, ok: true });
  } catch (err) {
    console.error('[bridge] print failed:', err.message);
    // the server marks the job Failed with this reason so the Print center shows what went wrong
    if (job.jobId) socket.emit('print-result', { jobId: job.jobId, ok: false, error: String(err.message).slice(0, 200) });
  }
});

/**
 * Labels: the POS sends a self-contained page sized with @page CSS. A Chromium browser
 * (Edge or Chrome, auto-detected) opens it in kiosk-printing mode, which sends the page's
 * window.print() straight to the Windows DEFAULT printer without a dialog — so set the
 * label printer (e.g. NIIMBOT B4) as the default printer on this PC.
 * Optional config.labelPrinter: { "browser": "C:\\path\\to\\msedge.exe", "timeoutMs": 20000 }
 */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function printLabel(html) {
  const label = config.labelPrinter ?? {};
  const browser = label.browser ?? BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) return Promise.reject(new Error('no Edge or Chrome found for label printing — set labelPrinter.browser in config.json'));
  const dir = path.join(os.tmpdir(), 'fmp-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const jobId = `job-${Date.now()}`;
  const file = path.join(dir, `label-${jobId}.html`);
  // one-shot profile: a reused profile remembers its last printer and would ignore a changed default
  const profile = path.join(dir, `profile-${jobId}`);
  fs.writeFileSync(file, html);
  // The launcher exits at once and the real browser carries on, so the browser is found
  // again by the job marker in its command line: wait for it to close itself (the page
  // calls window.close after printing), or close it once the label has had time to spool.
  execFile(browser, [
    '--kiosk-printing',
    '--no-first-run',
    '--disable-extensions',
    '--disable-gpu',
    `--user-data-dir=${profile}`,
    `--fmp-label=${jobId}`,
    `--app=${pathToFileURL(file).href}`,
  ], () => {});
  const settleMs = label.settleMs ?? 6000;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const running = await browserProcesses(jobId);
      if (running.length === 0 && Date.now() - started > 1500) return finish();
      if (Date.now() - started >= settleMs) {
        await killProcesses(running);
        return finish();
      }
      setTimeout(tick, 500);
    };
    const finish = () => {
      fs.rm(file, { force: true }, () => {});
      // the browser releases its profile a moment after exiting
      setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => {}), 2000);
      resolve();
    };
    setTimeout(tick, 500);
  });
}

/** PIDs of browser processes carrying this job's marker. */
function browserProcesses(jobId) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--fmp-label=${jobId}*' }).ProcessId -join ','`],
      { timeout: 8000 }, (err, stdout) => resolve(err ? [] : String(stdout).trim().split(',').filter(Boolean)));
  });
}

function killProcesses(pids) {
  if (pids.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/F', ...pids.flatMap((p) => ['/PID', p])], { timeout: 8000 }, () => resolve());
  });
}

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
  if (printer.mode === 'windows') {
    // USB printer installed in Windows: raw bytes straight into its queue, no driver, no share, no admin
    const tmp = path.join(os.tmpdir(), `fmp-receipt-${Date.now()}.bin`);
    fs.writeFileSync(tmp, bytes);
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rawprint.ps1');
    return new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PrinterName', printer.printerName, '-FilePath', tmp],
        { timeout: 30000 }, (err, _stdout, stderr) => {
          fs.unlink(tmp, () => {});
          if (err) reject(new Error((stderr || err.message).toString().split('\n').find((l) => l.trim()) || 'raw print failed'));
          else resolve();
        });
    });
  }
  return Promise.reject(new Error(`unknown receiptPrinter.mode "${printer.mode}" — use "tcp", "windows" or "share"`));
}
