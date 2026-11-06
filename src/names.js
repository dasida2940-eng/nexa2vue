'use strict';

// Output names per screen. The default is the source file name; a changed
// name renames the generated files (and, for the uni profile, the screen
// folder and the identifiers inside them).

const posix = require('./posix-path');
const { roleNames } = require('./screen-roles');

// Used in file names and in `export const {name}Constant`, so a JS identifier.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function defaultName(rel) {
  return posix.basename(rel).replace(/\.xfdl$/i, '');
}

/**
 * The screen ID a name becomes in the generated files (gen-uni.js): other
 * characters turn into "_", and a leading digit gets an "S". So 화면 and 목록
 * both become "__", and A-1 and A_1 both "A_1".
 */
function outputId(name) {
  const id = String(name).replace(/[^\w]/g, '_');
  return /^[A-Za-z_$]/.test(id) ? id : `S${id}`;
}

/**
 * forms: ['ua/usr/A.xfdl', ...]; renames: { rel: name } (blank or missing = default).
 * Returns { names: Map<rel, name>, renamed: Set<rel>, errors: [{ rel, message }] }.
 * Two screens in the same folder may not end up with the same name (Windows
 * file names ignore case, so neither may names that differ only in case).
 */
function resolveNames(forms, renames = {}) {
  const names = new Map();
  const renamed = new Set();
  const errors = [];
  for (const rel of forms) {
    const wanted = String((renames && renames[rel]) || '').trim();
    const fallback = defaultName(rel);
    if (wanted && wanted !== fallback) {
      if (!NAME_RE.test(wanted)) {
        errors.push({ rel, message: `이름 "${wanted}"은 쓸 수 없습니다. 영문자·숫자·밑줄(_)만, 첫 글자는 영문자나 밑줄로 쓰세요` });
        names.set(rel, fallback);
        continue;
      }
      renamed.add(rel);
      names.set(rel, wanted);
    } else {
      names.set(rel, fallback);
    }
  }
  const seen = new Map();
  for (const [rel, name] of names) {
    const id = outputId(name);
    const key = `${posix.dirname(rel)}/${id}`.toLowerCase();
    if (seen.has(key)) {
      const same = id === name ? '' : `, 영문자·숫자·밑줄 외 글자는 _로 바뀌어 ${id}`;
      errors.push({ rel, message: `같은 폴더의 ${seen.get(key)}와 출력 이름(${name}${same})이 겹칩니다. 출력 이름을 바꾸세요` });
    }
    else seen.set(key, rel);
  }
  return { names, renamed, errors };
}

/**
 * Names for resolveNames with the roles' defaults (screen-roles.js: popup ->
 * {부모ID+1}_POP, sub-screen -> {호스트}{Div}) under the explicit ones
 * (config "names" and names typed on the page). No roles: explicit only.
 */
function namesWithRoles(forms, explicit = {}, roles = null) {
  const given = Object.fromEntries(Object.entries(explicit || {}).filter(([, n]) => String(n || '').trim()));
  if (!roles) return given;
  const base = Object.fromEntries(forms.map((rel) => [rel, String(given[rel] || '').trim() || defaultName(rel)]));
  return { ...roleNames(forms, base, roles), ...given };
}

module.exports = { resolveNames, namesWithRoles, defaultName, outputId, NAME_RE };
