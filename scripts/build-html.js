#!/usr/bin/env node
'use strict';

// Builds dist/nexa2vue.html: the browser UI, the converters and the runtime
// assets bundled into one self-contained file that works from file://.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { viewerFiles } = require('../src/viewer-scaffold');
const { uniPreviewTemplates } = require('../src/uni-preview-scaffold');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'nexa2vue.html');

// Files the Node runner reads from disk, embedded as a virtual module.
const assetsPlugin = {
  name: 'nexa2vue-assets',
  setup(build) {
    build.onResolve({ filter: /^nexa2vue-assets$/ }, () => ({ path: 'nexa2vue-assets', namespace: 'assets' }));
    build.onLoad({ filter: /.*/, namespace: 'assets' }, () => ({
      loader: 'js',
      contents: `module.exports = ${JSON.stringify({
        compatSource: fs.readFileSync(path.join(ROOT, 'runtime', 'nexa-compat.js'), 'utf8'),
        viewerFiles: viewerFiles('nexa2vue-screens'),
        uniPreviewTemplates: uniPreviewTemplates(),
      })};`,
    }));
  },
};

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'browser', 'app.js')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome100', 'edge100', 'firefox100', 'safari15'],
    minify: true,
    legalComments: 'inline',
    plugins: [assetsPlugin],
  });
  // Inline <script>: "</script" inside the bundle would end the element early.
  const js = result.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'browser', 'index.html'), 'utf8')
    .replace('/*__CSS__*/', () => css)
    .replace('/*__APP__*/', () => js);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html, 'utf8');
  return { path: OUT, bytes: Buffer.byteLength(html) };
}

if (require.main === module) {
  build().then(({ path: p, bytes }) => console.log(`built ${p} (${Math.round(bytes / 1024)} KB)`)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { build, OUT };
