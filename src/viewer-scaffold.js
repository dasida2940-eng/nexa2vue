'use strict';

const fs = require('fs');
const path = require('path');

const SCAFFOLD_DIR = path.join(__dirname, '..', 'scaffold', 'viewer');
const SCAFFOLD_FILES = ['index.html', 'vite.config.js', 'src/main.js', 'src/App.vue', 'view-screens.cmd'];

// Versions verified with the generated screens (vite build + browser run).
const DEPENDENCIES = {
  vue: '3.5.13',
  'element-plus': '2.9.1',
};
const DEV_DEPENDENCIES = {
  vite: '6.0.7',
  '@vitejs/plugin-vue': '5.2.1',
};

function packageName(outputDir) {
  const name = path.basename(outputDir).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return name || 'nexa2vue-screens';
}

/**
 * Files for a standalone Vite project that lists and shows every converted
 * screen. Returns [{ path, content }] with POSIX paths relative to the output.
 */
function viewerFiles(outputDir) {
  const pkg = {
    name: packageName(outputDir),
    private: true,
    version: '0.0.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: DEPENDENCIES,
    devDependencies: DEV_DEPENDENCIES,
  };
  const files = [{ path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` }];
  for (const rel of SCAFFOLD_FILES) {
    let content = fs.readFileSync(path.join(SCAFFOLD_DIR, ...rel.split('/')), 'utf8');
    if (rel.endsWith('.cmd')) content = content.replace(/\r?\n/g, '\r\n');
    files.push({ path: rel, content });
  }
  return files;
}

module.exports = { viewerFiles };
