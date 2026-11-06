'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  cdataPropName: '__cdata',
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // Numeric character references (&#13;&#10; line breaks in grid headers). &amp; is still decoded last.
  htmlEntities: true,
});

/**
 * Parse XML text into a simple tree: { tag, attrs, children, text }.
 * Element order is preserved because Nexacro uses it for z-order and tab order.
 */
function parseXml(source) {
  const raw = parser.parse(source);
  const roots = normalizeList(raw);
  if (roots.length === 0) throw new Error('XML has no root element');
  return roots[0];
}

function normalizeList(list) {
  const out = [];
  for (const item of list || []) {
    const tag = Object.keys(item).find((k) => k !== ':@');
    if (!tag || tag === '#text' || tag === '__cdata') continue;
    out.push(normalizeElement(tag, item[tag], item[':@'] || {}));
  }
  return out;
}

function normalizeElement(tag, rawChildren, attrs) {
  let text = '';
  for (const child of rawChildren || []) {
    if ('#text' in child) text += child['#text'];
    if ('__cdata' in child) {
      for (const c of child.__cdata) if ('#text' in c) text += c['#text'];
    }
  }
  return { tag, attrs: { ...attrs }, children: normalizeList(rawChildren), text };
}

function child(node, tag) {
  return node ? node.children.find((c) => c.tag === tag) || null : null;
}

function childrenOf(node, tag) {
  return node ? node.children.filter((c) => c.tag === tag) : [];
}

module.exports = { parseXml, child, childrenOf };
