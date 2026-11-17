// Sample Electron main process (ES modules) using adapter-electron.
//
// The adapter is imported by package name, the way an app that depends on
// "github:<owner>/cdp-screenshot-extension#<tag>" would import it. Here the package is linked
// to the repository root (see package.json), so the package's own "exports" are what get used.
//
// Usage: yarn start [--page=multi-scroll] [--depth=5] [--format=png] [--selector=#right] [--hidden]
// Output: PNG files in ./out and one line per capture on stdout.

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { runCapture, runCaptureNode } from 'cdp-screenshot-extension/adapter-electron';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const root = path.resolve(import.meta.dirname, '../..');
const page = arg('page', 'multi-scroll');
const depth = Number(arg('depth', '5'));
const format = arg('format', 'png');
const outDir = path.join(import.meta.dirname, 'out');

async function main() {
  const win = new BrowserWindow({ width: 1280, height: 800, show: !flag('hidden') });
  await win.loadFile(path.join(root, 'test/fixtures', `${page}.html`));
  const options = { depth, format };

  fs.mkdirSync(outDir, { recursive: true });
  const save = (name, r) => {
    const ext = r.mime === 'image/jpeg' ? 'jpg' : r.mime.split('/')[1];
    const file = path.join(outDir, `${page}-${name}.${ext}`);
    fs.writeFileSync(file, r.bytes);
    console.log(`${name}: ${r.width}x${r.height} ${r.mime} -> ${file}`);
  };

  save('viewport', await runCapture(win.webContents, 'viewport', options));
  save('full', await runCapture(win.webContents, 'full', options));
  // Element by selector: the path for callers that cannot click (e.g. an MCP server).
  const selector = arg('selector', page === 'multi-scroll' ? '#right' : 'body');
  save('node', await runCaptureNode(win.webContents, selector, options));
}

app.whenReady().then(main).then(
  () => app.quit(),
  (e) => {
    console.error(`capture failed: ${e.code ?? ''} ${e.message}`);
    app.exit(1);
  },
);
