'use strict';

// The few POSIX path helpers the converters need, without Node's `path`, so
// the same code runs in the browser build.

function dirname(p) {
  const i = p.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : p.slice(0, i);
}

function basename(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

function relative(from, to) {
  const a = from.split('/').filter((s) => s && s !== '.');
  const b = to.split('/').filter((s) => s && s !== '.');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

module.exports = { dirname, basename, relative };
