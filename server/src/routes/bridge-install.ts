import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter as Router } from '../http';

/**
 * Serves the print-bridge installer and the handful of bridge files it downloads, so a store
 * PC is set up with one PowerShell line:  irm https://<pos>/bridge/install.ps1 | iex
 * Public on purpose: nothing here is secret (pairing still needs a manager-issued code), and
 * the file list is a fixed allow-list, never a directory walk.
 */
export const bridgeInstallRouter = Router();

const bridgeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bridge');
const FILES: Record<string, string> = {
  'package.json': 'application/json',
  'config.example.json': 'application/json',
  'src/index.js': 'text/javascript',
  'src/pair.js': 'text/javascript',
  'src/rawprint.ps1': 'text/plain',
};

bridgeInstallRouter.get('/install.ps1', (req, res) => {
  const host = req.get('host') ?? 'localhost';
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  const script = readFileSync(path.join(bridgeDir, 'install.ps1'), 'utf8').replace('__SERVER_URL__', `${proto}://${host}`);
  res.type('text/plain; charset=utf-8').send(script);
});

bridgeInstallRouter.get(/^\/files\/(.+)$/, (req, res) => {
  const name = req.params[0] ?? '';
  const type = FILES[name];
  if (!type) {
    res.status(404).json({ error: 'Not a bridge file' });
    return;
  }
  res.type(type).sendFile(path.join(bridgeDir, name));
});
