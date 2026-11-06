#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const { startServer } = require('../src/server');

function parseArgs(argv) {
  const args = { input: null, port: 3470 };
  for (let i = 0; i < argv.length; i++) {
    // --root: the old name, from when a work path came before the input folder
    if (argv[i] === '--input' || argv[i] === '--root') args.input = argv[++i];
    else if (argv[i] === '--port') args.port = Number.parseInt(argv[++i], 10);
    else if (argv[i] === '--open') args.open = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('Invalid --port');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'Usage: nexa2vue-web [--port 3470] [--input <folder>] [--open]',
      '',
      'Choose the input (Nexacro screens, .xfdl) and output folders in the web UI;',
      'both are required. --input presets the input folder.',
    ].join('\n'));
    return;
  }
  const server = await listen(args);
  const { port } = server.address();
  console.log(`[nexa2vue] open http://127.0.0.1:${port}  (Ctrl+C to stop)`);
  console.log(args.input ? `[nexa2vue] 입력 폴더: ${args.input}` : '[nexa2vue] 웹 화면에서 입력 폴더와 출력 폴더를 고르세요');
  if (args.open) openBrowser(`http://127.0.0.1:${port}/`);
}

// The port is often held by a nexa2vue started earlier (its window left open).
// Ask that one to stop so this, possibly newer, version takes over; if it
// cannot (older version without /api/shutdown, or a conversion is running),
// use the next free port instead.
async function listen(args) {
  const start = (port) => startServer({ input: args.input, port, shutdownable: true });
  try {
    return await start(args.port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || !args.port) throw err;
  }
  if (await isNexa2vue(args.port)) {
    const res = await post(args.port, '/api/shutdown');
    if (res && res.status === 200) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          return await start(args.port);
        } catch (err) {
          if (err.code !== 'EADDRINUSE') throw err;
        }
      }
    }
    console.log(res && res.status === 409
      ? `[nexa2vue] 이미 실행 중인 nexa2vue(포트 ${args.port})가 변환 중이라 다른 포트로 시작합니다.`
      : `[nexa2vue] 예전에 실행한 nexa2vue(포트 ${args.port})가 남아 있어 다른 포트로 시작합니다. 예전 서버 창은 닫아도 됩니다.`);
  } else {
    console.log(`[nexa2vue] 포트 ${args.port}를 다른 프로그램이 쓰고 있어 다른 포트로 시작합니다.`);
  }
  for (let port = args.port + 1; port <= args.port + 20; port++) {
    try {
      return await start(port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  return start(0);
}

function isNexa2vue(port) {
  return fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      if (!res.ok) return false;
      const body = await res.json();
      // older versions answer { root }
      return body.app === 'nexa2vue' || 'root' in body;
    })
    .catch(() => false);
}

function post(port, urlPath) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
}

// --open: show the UI in the default browser (used by the double-click launcher)
function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

main().catch((err) => {
  console.error(`[nexa2vue] ${err.message}`);
  process.exit(1);
});
