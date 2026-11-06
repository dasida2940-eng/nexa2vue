'use strict';

const fs = require('fs');
const path = require('path');
const { decodeSource } = require('./decode');

const { SKIP_DIRS, SOURCE_EXT } = require('./scanner-rules');

/**
 * Recursively list Nexacro sources. Symlinks are not followed so a scan can
 * never escape the selected folder.
 */
function listSources(inputDir, { maxFiles = 5000, maxBytes = 5 * 1024 * 1024 } = {}) {
  const files = [];
  const skipped = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ rel: path.relative(inputDir, dir), reason: err.code || err.message });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(inputDir, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(abs);
        continue;
      }
      const kind = SOURCE_EXT[path.extname(entry.name).toLowerCase()];
      if (!kind) continue;
      const size = fs.statSync(abs).size;
      if (size > maxBytes) {
        skipped.push({ rel, reason: `larger than ${maxBytes} bytes` });
      } else if (files.length >= maxFiles) {
        skipped.push({ rel, reason: `file limit ${maxFiles} reached` });
      } else {
        files.push({ rel, abs, size, kind });
      }
    }
  };
  walk(inputDir);
  return { files, skipped };
}

/**
 * True when at least one Nexacro screen (.xfdl) exists under dir (any depth).
 * Stops at the first match so large folders stay fast.
 */
function hasFormSource(dir) {
  const stack = [dir];
  while (stack.length) {
    let entries;
    try {
      entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(path.join(entry.parentPath || entry.path, entry.name));
      } else if (path.extname(entry.name).toLowerCase() === '.xfdl') {
        return true;
      }
    }
  }
  return false;
}

function readSource(abs) {
  return decodeSource(fs.readFileSync(abs));
}

module.exports = { listSources, hasFormSource, decodeSource, readSource, SKIP_DIRS, SOURCE_EXT };
