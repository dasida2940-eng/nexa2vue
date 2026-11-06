'use strict';

const fs = require('fs');
const path = require('path');

const caseInsensitive = process.platform === 'win32';

function norm(p) {
  const resolved = path.resolve(p);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/** True when `child` equals `parent` or is inside it. */
function isInside(parent, child) {
  const a = norm(parent);
  const b = norm(child);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** Resolve symlinks for existing paths; for new paths resolve the nearest existing parent. */
function realResolve(p) {
  let current = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), ...rest);
}

/**
 * Join an output-relative POSIX path onto the output root, refusing anything
 * that escapes it.
 */
function safeJoin(root, relPosix) {
  const target = path.resolve(root, ...relPosix.split('/'));
  if (!isInside(root, target) || target === path.resolve(root)) {
    throw new Error(`Refusing to write outside output folder: ${relPosix}`);
  }
  return target;
}

module.exports = { isInside, realResolve, safeJoin };
