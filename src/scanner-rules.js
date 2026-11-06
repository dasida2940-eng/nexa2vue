'use strict';

// Which folders are skipped and which files are Nexacro sources. Shared by the
// Node scanner and the browser build.
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '_nexa2vue_out']);
const SOURCE_EXT = { '.xfdl': 'form', '.xjs': 'lib' };

module.exports = { SKIP_DIRS, SOURCE_EXT };
