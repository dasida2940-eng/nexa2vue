'use strict';

// Output name per screen, edited in the preview list. Shared by the server UI
// (loaded as a plain script, global `nexaNameTable`) and the HTML build
// (bundled with require). Text goes in with textContent only.
(function (root) {
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const ROLE_LABEL = { screen: '화면', sub: '하위 화면', popup: '팝업' };

  function outputPathOf(rel, name, profile) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
    return profile === 'uni' ? `src/views/${dir}${name}/${name}View.vue` : `src/views/${dir}${name}.vue`;
  }

  /**
   * forms: ['ua/usr/A.xfdl', ...]; defaults: { rel: name }; names: Map<rel, name>
   * (the edits, kept by the caller so they survive re-rendering);
   * getProfile(): 'element' | 'uni'.
   * review (optional, uni): { roles: { rel: { role, parent, reasons } }, onRoleChange(rel, { role, parent }) }
   *   adds 종류·부모·근거 columns for checking popups and sub-screens before conversion.
   * Returns { table, refresh, hasErrors }.
   */
  function create(forms, defaults, names, getProfile, review) {
    const roles = review && review.roles;
    const table = document.createElement('table');
    table.className = 'files names';
    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    const headers = roles
      ? ['원본 화면', '종류', '부모 화면', '출력 이름 (바꾸면 파일·폴더명이 따라 바뀜)', '결과 파일', '이렇게 본 근거']
      : ['원본 화면', '출력 이름 (바꾸면 파일·폴더명이 따라 바뀜)', '결과 파일'];
    for (const text of headers) {
      const th = document.createElement('th');
      th.textContent = text;
      hr.append(th);
    }
    head.append(hr);
    const body = document.createElement('tbody');
    table.append(head, body);

    const rows = forms.map((rel) => {
      const tr = document.createElement('tr');
      const src = document.createElement('td');
      src.textContent = rel;
      const nameCell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = names.has(rel) ? names.get(rel) : defaults[rel];
      input.placeholder = defaults[rel];
      input.setAttribute('aria-label', `${rel} 출력 이름`);
      input.addEventListener('input', () => {
        names.set(rel, input.value.trim());
        refresh();
      });
      nameCell.append(input);
      const out = document.createElement('td');
      out.className = 'path';
      if (!roles) {
        tr.append(src, nameCell, out);
        body.append(tr);
        return { rel, input, out };
      }
      const r = roles[rel] || { role: 'screen', parent: null, reasons: [] };
      const roleCell = document.createElement('td');
      const roleSelect = document.createElement('select');
      roleSelect.setAttribute('aria-label', `${rel} 종류`);
      for (const [value, label] of Object.entries(ROLE_LABEL)) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        roleSelect.append(o);
      }
      roleSelect.value = r.role;
      roleCell.append(roleSelect);
      const parentCell = document.createElement('td');
      const parentSelect = document.createElement('select');
      parentSelect.setAttribute('aria-label', `${rel} 부모 화면`);
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '(없음)';
      parentSelect.append(none);
      for (const other of forms.filter((f) => f !== rel)) {
        const o = document.createElement('option');
        o.value = other;
        o.textContent = other;
        parentSelect.append(o);
      }
      parentSelect.value = r.parent || '';
      parentSelect.disabled = r.role === 'screen';
      parentCell.append(parentSelect);
      const why = document.createElement('td');
      why.className = 'reason';
      why.textContent = (r.reasons || []).join(' · ');
      const changed = () => review.onRoleChange(rel, { role: roleSelect.value, parent: roleSelect.value === 'screen' ? null : parentSelect.value || null });
      roleSelect.addEventListener('change', changed);
      parentSelect.addEventListener('change', changed);
      tr.classList.toggle('role-sub', r.role === 'sub');
      tr.classList.toggle('role-popup', r.role === 'popup');
      tr.append(src, roleCell, parentCell, nameCell, out, why);
      body.append(tr);
      return { rel, input, out };
    });

    // uni with roles: a sub-screen is a component in its host screen's folder.
    function hostOf(rel) {
      let cur = rel;
      const seen = new Set();
      while (roles && roles[cur] && roles[cur].role === 'sub' && roles[cur].parent && !seen.has(cur)) {
        seen.add(cur);
        cur = roles[cur].parent;
      }
      return cur;
    }
    const nameOf = (rel) => {
      const row = rows.find((x) => x.rel === rel);
      return (row && row.input.value.trim()) || defaults[rel];
    };
    function pathOf(rel, name) {
      if (roles && roles[rel] && roles[rel].role === 'sub' && getProfile() === 'uni') {
        const host = hostOf(rel);
        const dir = host.includes('/') ? host.slice(0, host.lastIndexOf('/') + 1) : '';
        return `src/views/${dir}${nameOf(host)}/${name}.vue`;
      }
      return outputPathOf(rel, name, getProfile());
    }

    let errorCount = 0;
    function refresh() {
      errorCount = 0;
      const seen = new Map();
      for (const r of rows) {
        const name = r.input.value.trim() || defaults[r.rel];
        const changed = name !== defaults[r.rel];
        const key = `${r.rel.slice(0, r.rel.lastIndexOf('/') + 1)}${name}`.toLowerCase();
        let error = '';
        // The file name default may hold characters a new name may not (kept as before).
        if (changed && !NAME_RE.test(name)) error = '영문자·숫자·밑줄만, 첫 글자는 영문자나 밑줄';
        else if (seen.has(key)) error = `${seen.get(key)}와 이름이 겹침`;
        seen.set(key, r.rel);
        r.input.classList.toggle('invalid', !!error);
        r.input.classList.toggle('changed', changed && !error);
        r.out.textContent = error || pathOf(r.rel, name);
        r.out.classList.toggle('error', !!error);
        if (error) errorCount++;
      }
    }
    refresh();
    return { table, refresh, hasErrors: () => errorCount > 0 };
  }

  const api = { create, outputPathOf, NAME_RE, ROLE_LABEL };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nexaNameTable = api;
})(typeof window !== 'undefined' ? window : this);
