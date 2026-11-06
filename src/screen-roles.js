'use strict';

// Which screens are sub-screens or popups of another, before conversion.
// Nexacro links screens by form URL ("ua::BAU0101011.xfdl"): a Div or Tabpage
// with url="…" (or div.set_url("…")) embeds a sub-screen; any other form URL
// in the script (ChildFrame, showModal, gfn_openPopup …) opens a popup. A
// screen's own script and name give hints too (this.close(), "_P", "팝업").
// The result is only a guess shown for review; the person converting confirms
// or changes it, and the conversion follows what was confirmed.
//
// Shared by the Node side and the web page (plain script, global
// `nexaScreenRoles`), so it has no require().
(function (root) {
  const ROLES = ['screen', 'sub', 'popup'];
  const ROLE_LABEL = { screen: '화면', sub: '하위 화면', popup: '팝업' };
  const SCREEN_ID = /^([A-Z]{3})(\d{7})$/;

  // "ua::usr/BAU0101011.xfdl" -> "usr/bau0101011.xfdl" (prefix dropped, lower case)
  function refPath(url) {
    const s = String(url).trim().replace(/\\/g, '/');
    const i = s.lastIndexOf('::');
    return (i >= 0 ? s.slice(i + 2) : s).replace(/^\.?\/+/, '').toLowerCase();
  }

  /** The form a form URL points at: same path tail, else the only one with that file name. */
  function resolveRef(url, forms) {
    const p = refPath(url);
    if (!p.endsWith('.xfdl')) return null;
    const lower = forms.map((rel) => ({ rel, l: rel.toLowerCase() }));
    const tail = lower.filter((f) => f.l === p || f.l.endsWith(`/${p}`));
    if (tail.length === 1) return tail[0].rel;
    const base = p.slice(p.lastIndexOf('/') + 1);
    const byName = lower.filter((f) => f.l === base || f.l.endsWith(`/${base}`));
    return byName.length === 1 ? byName[0].rel : null;
  }

  function scriptOf(text) {
    const m = /<Script\b[^>]*>([\s\S]*?)<\/Script>/i.exec(text);
    return m ? m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '') : '';
  }

  /**
   * Links and hints of one .xfdl source.
   * Returns { embeds: [{ url, compId }], opens: [{ url }], hints: { popup: [], sub: [] }, title }.
   */
  function scanSource(text, rel) {
    const embeds = [];
    const opens = [];
    const layout = text.replace(/<Script\b[\s\S]*?<\/Script>/gi, '');
    for (const m of layout.matchAll(/<(Div|Tabpage)\b([^>]*)>/gi)) {
      const url = /\surl="([^"]*)"/i.exec(m[2]);
      if (!url || !url[1].trim()) continue;
      const id = /\sid="([^"]*)"/i.exec(m[2]);
      embeds.push({ url: url[1], compId: id ? id[1] : '' });
    }
    const script = scriptOf(text);
    const embedded = new Set();
    for (const m of script.matchAll(/(?:this\.)?([\w.]+)\.set_url\(\s*["']([^"']+)["']/g)) {
      embeds.push({ url: m[2], compId: m[1].split('.').pop() });
      embedded.add(m[2]);
    }
    for (const m of script.matchAll(/["']([^"'\r\n]+\.xfdl)["']/gi)) {
      if (!embedded.has(m[1])) opens.push({ url: m[1] });
    }
    const hints = { popup: [], sub: [] };
    if (/\bthis\.close\s*\(/.test(script)) hints.popup.push('스크립트에서 this.close()로 스스로 닫음');
    if (/\b(opener|getOwnerFrame\(\)\.arguments|parent\.arguments)\b/.test(script)) hints.popup.push('스크립트에서 여는 쪽 인자(opener/arguments)를 읽음');
    const base = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.xfdl$/i, '');
    if (/(_P\d*|POP\d*|_pop\d*|Popup)$/i.test(base)) hints.popup.push(`파일 이름(${base})이 팝업 이름 꼴`);
    const title = (/<Form\b[^>]*\stitletext="([^"]*)"/i.exec(text) || [])[1] || '';
    if (/팝업|popup/i.test(title)) hints.popup.push(`제목(${title})에 팝업`);
    if (/\bthis\.parent\.parent\b|\bthis\.parent\.fn_\w+/.test(script)) hints.sub.push('스크립트에서 부모 화면(this.parent…)을 부름');
    return { embeds, opens, hints, title };
  }

  /**
   * Guess every screen's role. sources: [{ rel, text }].
   * Returns { rel: { role, parent, via, reasons } }; via: { kind: 'embed', compId } | { kind: 'open' } | null.
   */
  function detectRoles(sources) {
    const forms = sources.map((s) => s.rel);
    const scans = new Map(sources.map((s) => [s.rel, scanSource(s.text, s.rel)]));
    const embeddedBy = new Map();
    const openedBy = new Map();
    const add = (map, rel, entry) => {
      if (!map.has(rel)) map.set(rel, []);
      map.get(rel).push(entry);
    };
    for (const [from, scan] of scans) {
      for (const e of scan.embeds) {
        const to = resolveRef(e.url, forms);
        if (to && to !== from) add(embeddedBy, to, { from, compId: e.compId, url: e.url });
      }
      for (const o of scan.opens) {
        const to = resolveRef(o.url, forms);
        if (to && to !== from) add(openedBy, to, { from, url: o.url });
      }
    }
    const roles = {};
    for (const rel of forms) {
      const scan = scans.get(rel);
      const emb = embeddedBy.get(rel) || [];
      const opn = openedBy.get(rel) || [];
      const reasons = [];
      let role = 'screen';
      let parent = null;
      let via = null;
      if (emb.length) {
        role = 'sub';
        parent = emb[0].from;
        via = { kind: 'embed', compId: emb[0].compId };
        reasons.push(`${emb[0].from}의 ${emb[0].compId || '영역'}에 들어감(url=${emb[0].url})`);
        if (emb.length > 1) reasons.push(`다른 화면에도 들어감: ${emb.slice(1).map((e) => e.from).join(', ')} — 한 부모만 고를 수 있음`);
      } else if (opn.length) {
        role = 'popup';
        parent = opn[0].from;
        via = { kind: 'open' };
        reasons.push(`${opn[0].from}의 스크립트에서 엶(${opn[0].url})`);
        if (opn.length > 1) reasons.push(`다른 화면도 엶: ${opn.slice(1).map((o) => o.from).join(', ')}`);
      } else if (scan.hints.popup.length) {
        role = 'popup';
        reasons.push('여는 화면을 찾지 못함 — 부모를 고르세요');
      }
      if (role !== 'popup') reasons.push(...scan.hints.popup.map((h) => `팝업일 수도: ${h}`));
      else reasons.push(...scan.hints.popup);
      if (role === 'sub') reasons.push(...scan.hints.sub);
      else if (scan.hints.sub.length) reasons.push(...scan.hints.sub.map((h) => `하위 화면일 수도: ${h}`));
      if (!reasons.length) reasons.push('다른 화면이 넣거나 열지 않음');
      roles[rel] = { role, parent, via, reasons };
    }
    return roles;
  }

  /**
   * Roles as confirmed on the page, made safe: known roles only, a parent that
   * is another screen in the run, and no loops (a loop falls back to 화면).
   * A sub-screen's parent may be another sub-screen; it lands in the top one.
   */
  function normalizeRoles(forms, roles) {
    const set = new Set(forms);
    const out = {};
    for (const rel of forms) {
      const r = (roles && roles[rel]) || {};
      const role = ROLES.includes(r.role) ? r.role : 'screen';
      const parent = role !== 'screen' && set.has(r.parent) && r.parent !== rel ? r.parent : null;
      out[rel] = { role: role === 'sub' && !parent ? 'screen' : role, parent, via: r.via || null, reasons: Array.isArray(r.reasons) ? r.reasons : [] };
    }
    for (const rel of forms) {
      const seen = new Set([rel]);
      let p = out[rel].role === 'sub' ? out[rel].parent : null;
      while (p && out[p].role === 'sub' && out[p].parent && !seen.has(p)) {
        seen.add(p);
        p = out[p].parent;
      }
      if (p && seen.has(p)) {
        out[rel] = { ...out[rel], role: 'screen', parent: null, reasons: [...out[rel].reasons, '부모 관계가 돌고 돌아 화면으로 둠'] };
      }
    }
    return out;
  }

  /** Guessed roles with the ones changed on the page laid over (reasons kept, the change noted). */
  function withEdits(detected, edits) {
    const out = { ...detected };
    for (const [rel, e] of Object.entries(edits || {})) {
      if (!e || typeof e !== 'object') continue;
      const d = detected[rel] || { role: 'screen', parent: null, via: null, reasons: [] };
      const same = e.role === d.role && (e.parent || null) === (d.parent || null);
      out[rel] = { ...d, ...e, reasons: same ? d.reasons : [`화면 검토에서 바꿈(처음 판단: ${ROLE_LABEL[d.role]}${d.parent ? `, 부모 ${d.parent}` : ''})`, ...d.reasons] };
    }
    return out;
  }

  /** The screen a sub-screen's files go into (walks up through sub-screens). */
  function hostOf(rel, roles) {
    let cur = rel;
    const seen = new Set();
    while (roles[cur] && roles[cur].role === 'sub' && roles[cur].parent && !seen.has(cur)) {
      seen.add(cur);
      cur = roles[cur].parent;
    }
    return cur;
  }

  function pascal(s) {
    return String(s).replace(/^(div|tabpage|tab|tp)_?/i, '').split(/[^A-Za-z0-9]+/).filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  }

  /**
   * Default output names that follow the roles (uni rules):
   * - popup: parent screen ID + 1 + "_POP" (BAU0101010 -> BAU0101011_POP, then …12_POP),
   *   else its own name + "_POP";
   * - sub-screen: host screen name + the Div's id (div_detail -> BAU0101010Detail).
   * base: { rel: name } without roles (file name or config). Explicit renames win over these.
   */
  function roleNames(forms, base, roles) {
    const names = { ...base };
    const dirOf = (rel) => rel.slice(0, rel.lastIndexOf('/') + 1);
    const taken = new Set(forms.map((rel) => `${dirOf(rel)}${base[rel]}`.toLowerCase()));
    const claim = (rel, name) => {
      const key = `${dirOf(rel)}${name}`.toLowerCase();
      if (taken.has(key)) return false;
      taken.add(key);
      names[rel] = name;
      return true;
    };
    const popupCount = new Map();
    for (const rel of forms) {
      const r = roles[rel];
      if (!r || r.role !== 'popup' || /_POP$/.test(base[rel])) continue;
      const m = r.parent && SCREEN_ID.exec(base[r.parent] || '');
      if (m) {
        let n = popupCount.get(r.parent) || 0;
        do n++; while (n < 10 && !claim(rel, `${m[1]}${String(Number(m[2]) + n).padStart(7, '0')}_POP`));
        popupCount.set(r.parent, n);
      } else {
        claim(rel, `${base[rel]}_POP`);
      }
    }
    for (const rel of forms) {
      const r = roles[rel];
      if (!r || r.role !== 'sub') continue;
      const hostName = names[hostOf(rel, roles)];
      const own = base[rel];
      const part = (r.via && r.via.compId && pascal(r.via.compId)) || pascal(own.startsWith(hostName) ? own.slice(hostName.length) : own) || 'Sub';
      for (let i = 1; i < 50 && !claim(rel, `${hostName}${part}${i > 1 ? i : ''}`); i++);
    }
    return names;
  }

  const api = { ROLES, ROLE_LABEL, detectRoles, normalizeRoles, withEdits, roleNames, hostOf, resolveRef, scanSource };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.nexaScreenRoles = api;
})(typeof window !== 'undefined' ? window : this);
