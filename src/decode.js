'use strict';

const KOREAN_LEGACY = /^(euc-kr|ks_c_5601-1987|cp949|ms949|x-windows-949)$/i;

/**
 * Decode a source file (Buffer or Uint8Array). Honors the XML declaration,
 * otherwise tries UTF-8 and falls back to EUC-KR (common in older Nexacro
 * projects). Uses only TextDecoder so it also runs in the browser.
 */
function decodeSource(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  // UTF-16 with a BOM (a file saved again by another editor)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  const head = String.fromCharCode(...bytes.subarray(0, 200));
  const declared = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  if (declared && KOREAN_LEGACY.test(declared[1])) {
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'euc-kr' };
  }
}

module.exports = { decodeSource };
