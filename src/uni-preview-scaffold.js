'use strict';

const fs = require('fs');
const path = require('path');
const { uniPreviewFiles: buildFiles, DEFAULT_UNI_FRONTEND } = require('./uni-preview-files');

const SCAFFOLD_DIR = path.join(__dirname, '..', 'scaffold', 'uni-preview');
const SCAFFOLD_FILES = ['index.html', 'vite.config.js', 'preview/main.js', 'preview/App.vue', 'preview/mock-api.js', 'preview/start.mjs', 'view-screens.cmd'];

// Template files as [{ path, content }] from scaffold/uni-preview.
function uniPreviewTemplates() {
  return SCAFFOLD_FILES.map((rel) => {
    let content = fs.readFileSync(path.join(SCAFFOLD_DIR, ...rel.split('/')), 'utf8');
    if (rel.endsWith('.cmd')) content = content.replace(/\r?\n/g, '\r\n');
    return { path: rel, content };
  });
}

function uniPreviewFiles(uniFrontend) {
  return buildFiles(uniFrontend, uniPreviewTemplates());
}

module.exports = { uniPreviewFiles, uniPreviewTemplates, DEFAULT_UNI_FRONTEND };
