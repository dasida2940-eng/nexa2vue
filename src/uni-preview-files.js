'use strict';

// Pure part of the uni style preview scaffold (no fs), shared with the browser build.
const DEFAULT_UNI_FRONTEND = 'C:\\uni_averedu\\frontend';

/**
 * Files for the uni style preview: the converted screens run with the uni
 * frontend's components, styles and packages, read from uniFrontend in place
 * (nothing is installed or written there). templates: [{ path, content }]
 * from scaffold/uni-preview.
 */
function uniPreviewFiles(uniFrontend, templates) {
  const pkg = { name: 'nexa2vue-uni-preview', private: true, type: 'module', scripts: { dev: 'node preview/start.mjs' } };
  return [
    { path: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { path: 'uni-preview.config.json', content: `${JSON.stringify({ uniFrontend: uniFrontend || DEFAULT_UNI_FRONTEND }, null, 2)}\n` },
    ...templates,
  ];
}

module.exports = { uniPreviewFiles, DEFAULT_UNI_FRONTEND };
