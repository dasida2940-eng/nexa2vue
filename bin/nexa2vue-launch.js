#!/usr/bin/env node
'use strict';

// Double-click launcher ("nexa2vue 서버 실행.cmd"): installs the runtime
// packages on first run, then starts the web server and opens the browser.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const missing = Object.keys(pkg.dependencies || {}).filter((name) => !fs.existsSync(path.join(root, 'node_modules', name, 'package.json')));

if (missing.length) {
  console.log(`[nexa2vue] 처음 실행이라 필요한 패키지를 설치합니다: ${missing.join(', ')}`);
  const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (npm.status !== 0) {
    console.error('[nexa2vue] 패키지 설치에 실패했습니다. 인터넷 연결이나 사내 npm 설정을 확인하세요.');
    process.exit(1);
  }
}

console.log('[nexa2vue] 서버를 시작합니다. 사용하는 동안 이 창을 닫지 마세요. 끝내려면 이 창을 닫거나 Ctrl+C를 누르세요.');
// NEXA2VUE_NO_OPEN=1: start without opening the browser (checks, remote desktops)
const open = process.env.NEXA2VUE_NO_OPEN ? [] : ['--open'];
process.argv = [process.argv[0], path.join(__dirname, 'nexa2vue-web.js'), ...open, ...process.argv.slice(2)];
require('./nexa2vue-web.js');
