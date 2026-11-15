// Sample Electron main process (CommonJS) using adapter-electron through a dynamic import().
//
// An app that depends on "github:<owner>/cdp-screenshot-extension#<tag>" would write:
//   const { runCapture, runCaptureNode } = await import('cdp-screenshot-extension/adapter-electron');
// Here the adapter is imported by path because the sample lives inside the repository.
//
// Usage: yarn start [--page=multi-scroll] [--depth=3] [--format=png] [--hidden]
// Output: PNG files in ./out and one line per capture on stdout.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const root = path.resolve(__dirname, '../..');
const page = arg('page', 'multi-scroll');
const depth = Number(arg('depth', '3'));
const format = arg('format', 'png');
const outDir = path.join(__dirname, 'out');

async function main() {
  await app.whenReady();
  const { runCapture, runCaptureNode } = await import(
    pathToFileURL(path.join(root, 'adapter-electron/index.js')).href
  );

  const win = new BrowserWindow({ width: 1280, height: 800, show: !flag('hidden') });
  await win.loadFile(path.join(root, 'test/fixtures', `${page}.html`));
  const options = { depth, format, settleMs: 250 };

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

main().then(
  () => app.quit(),
  (e) => {
    console.error(`capture failed: ${e.code ?? ''} ${e.message}`);
    app.exit(1);
  },
);
