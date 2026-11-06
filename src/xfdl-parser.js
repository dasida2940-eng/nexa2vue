'use strict';

const { parseXml, child, childrenOf } = require('./xml');

// Tags that live inside a component element but are not child components.
const NON_COMPONENT_TAGS = new Set(['Layouts', 'Formats', 'Tabpages', 'Objects', 'Bind', 'Script', 'Init', 'InitValue']);

/**
 * Parse a Nexacro form (.xfdl) into an intermediate representation:
 * {
 *   id, attrs, components: [Component], datasets: [Dataset],
 *   binds: [{ compPath, propid, datasetid, columnid }], script, includes: []
 * }
 * Component = { type, id, attrs, children: [Component], tabpages?, grid? }
 */
function parseXfdl(source) {
  const root = parseXml(source);
  const form = root.tag === 'Form' ? root : child(root, 'Form');
  if (!form) throw new Error('No <Form> element found');

  return {
    id: form.attrs.id || 'Form',
    attrs: form.attrs,
    components: parseComponentContainer(form),
    datasets: childrenOf(child(form, 'Objects'), 'Dataset').map(parseDataset),
    binds: childrenOf(child(form, 'Bind'), 'BindItem').map((b) => ({
      compPath: b.attrs.compid || '',
      propid: b.attrs.propid || 'value',
      datasetid: b.attrs.datasetid || '',
      columnid: b.attrs.columnid || '',
    })),
    script: (child(form, 'Script') || { text: '' }).text,
  };
}

/**
 * Components are either under <Layouts><Layout> (Nexacro 17/N) or directly
 * under the container element (Nexacro 14).
 */
function parseComponentContainer(node) {
  const layouts = child(node, 'Layouts');
  const layout = layouts ? child(layouts, 'Layout') : null;
  const source = layout || node;
  return source.children.filter((c) => !NON_COMPONENT_TAGS.has(c.tag) && c.tag !== 'Layout').map(parseComponent);
}

function parseComponent(node) {
  const comp = { type: node.tag, id: node.attrs.id || '', attrs: node.attrs, children: [] };
  if (node.tag === 'Tab') {
    comp.tabpages = childrenOf(child(node, 'Tabpages'), 'Tabpage').map((tp) => ({
      id: tp.attrs.id || '',
      text: tp.attrs.text || tp.attrs.id || '',
      children: parseComponentContainer(tp),
    }));
  } else if (node.tag === 'Grid') {
    comp.grid = parseGridFormat(node);
  } else {
    comp.children = parseComponentContainer(node);
  }
  return comp;
}

function parseGridFormat(node) {
  const formats = childrenOf(child(node, 'Formats'), 'Format');
  const format = formats.find((f) => f.attrs.id === 'default') || formats[0];
  if (!format) return { columns: [] };

  const sizes = childrenOf(child(format, 'Columns'), 'Column').map((c) => c.attrs.size || '');
  const band = (id) => childrenOf(childrenOf(format, 'Band').find((b) => b.attrs.id === id), 'Cell');
  const headByCol = new Map(band('head').map((c) => [Number(c.attrs.col || 0), c.attrs.text || '']));

  const columns = band('body').map((cell) => {
    const col = Number(cell.attrs.col || 0);
    const text = cell.attrs.text || '';
    const m = /^bind:(.+)$/.exec(text);
    return {
      col,
      label: headByCol.get(col) || '',
      prop: m ? m[1] : '',
      expr: m ? '' : text,
      width: sizes[col] || '',
      attrs: cell.attrs,
    };
  });
  return { columns };
}

function parseDataset(node) {
  const columns = childrenOf(child(node, 'ColumnInfo'), 'Column').map((c) => ({
    id: c.attrs.id,
    type: c.attrs.type || 'STRING',
  }));
  const rows = childrenOf(child(node, 'Rows'), 'Row').map((row) => {
    const obj = {};
    for (const col of childrenOf(row, 'Col')) obj[col.attrs.id] = col.text;
    return obj;
  });
  return { id: node.attrs.id || '', columns, rows };
}

/**
 * Library scripts (.xjs) are either a bare script or wrapped in <Script>.
 */
function extractXjsScript(source) {
  const trimmed = source.replace(/^﻿/, '').trimStart();
  if (!trimmed.startsWith('<')) return source;
  const root = parseXml(source);
  return root.tag === 'Script' ? root.text : (child(root, 'Script') || { text: '' }).text;
}

module.exports = { parseXfdl, extractXjsScript };
