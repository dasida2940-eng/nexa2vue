'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkComponentUse, componentSpec, startTags } = require('../src/component-check');

// A frontend with a few common components, declared the ways uni declares them.
function frontend() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2v-components-'));
  const add = (rel, script) => {
    fs.mkdirSync(path.dirname(path.join(root, 'src', 'components', rel)), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'components', rel), `<template><div /></template>\n<script setup>\n${script}\n</script>\n`);
  };
  add('form/Field.vue', "const props = defineProps({\n  item: { type: Object, required: true },\n  model: { type: Object, required: true },\n  disabled: { type: Boolean, default: false },\n})");
  add('ui/Button.vue', "defineProps({ color: String, iconOnly: Boolean })");
  add('form/Editor.vue', "const model = defineModel({ type: String, default: '' })");
  add('ui/PopupOutlet.vue', "import { ref } from 'vue'");
  // props built from elsewhere: not known for sure, so never checked
  add('ui/Odd.vue', "import base from './base'\ndefineProps({ ...base, label: { type: String, required: true } })");
  return root;
}

const view = (template, imports = "import { Button, Editor, Field, Odd, PopupOutlet } from '@/components'") =>
  `<template>\n${template}\n</template>\n\n<script setup>\n${imports}\n</script>\n`;

test('component specs come from defineProps and defineModel; props spread from elsewhere are unknown', () => {
  const spec = componentSpec("<script setup>\ndefineProps({ item: { type: Object, required: true }, tag: String })\ndefineModel('open', { required: true })\n</script>");
  assert.deepEqual([...spec.props], [['item', { required: true }], ['tag', { required: false }], ['open', { required: true }]]);
  assert.deepEqual([...componentSpec("<script setup>\ndefineProps(['a', 'b'])\n</script>").props], [['a', { required: false }], ['b', { required: false }]]);
  assert.equal(componentSpec("<script setup>\ndefineProps({ ...base })\n</script>"), null);
  assert.equal(componentSpec("<script setup>\ndefineProps(PROPS)\n</script>"), null);
  // Options API: props read from export default (or defineComponent)
  assert.deepEqual([...componentSpec("<script>\nexport default defineComponent({ props: { label: { type: String, required: true } } })\n</script>").props], [['label', { required: true }]]);
  assert.equal(componentSpec('<script>\nexport default { props: base }\n</script>'), null);
  assert.equal(componentSpec('<script setup>\nconst = broken\n</script>'), null);
});

test('start tags keep quoted values whole, so ">" inside a value does not end the tag', () => {
  const tags = startTags('<div><Field :item="a > b ? x : y" disabled @update="(k, v) => set(k, v)" /><span>');
  assert.deepEqual(tags.map((t) => [t.name, t.attrs]), [['div', []], ['Field', [':item', 'disabled', '@update']], ['span', []]]);
});

test('Field with v-model instead of item/model is caught, with its line; correct use is not', () => {
  const root = frontend();
  try {
    const bad = view([
      '  <div class="selector-box">',
      '    <Field v-model="params.gwamokCd" type="text" :maxlength="50" @keyup.enter="open" />',
      '    <!-- <Field v-model="commented.out" /> -->',
      '    <Field :item="items.cd" :model="params" @update="onUpdate" />',
      '    <field v-bind:item="items.nm" :model="params" />',
      '  </div>',
    ].join('\n'));
    const issues = checkComponentUse([{ path: 'src/views/A/AView.vue', content: bad }, { path: 'src/views/A/AService.js', content: '<Field v-model="x" />' }], root);
    assert.deepEqual(issues, [{
      file: 'src/views/A/AView.vue',
      line: 3,
      component: 'Field',
      message: '<Field> 필수 prop item·model 없음, v-model를 받지 않음(modelValue prop 없음)',
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only components imported from @/components are checked, and only what their declarations make certain', () => {
  const root = frontend();
  try {
    const ok = view([
      '  <Field v-bind="fieldProps" />',
      '  <Button color="secondary" icon-type="search" iconOnly @click="go">조회</Button>',
      '  <Editor v-model="text" />',
      '  <Odd />',
      '  <template #gwamok><Field :item="items.cd" :model="params" :disabled="true" /></template>',
    ].join('\n'));
    assert.deepEqual(checkComponentUse([{ path: 'V.vue', content: ok }], root), []);
    // a screen's own Field (not the common one) is not ours to judge
    const local = view('  <Field v-model="x" />', "import Field from './Field.vue'");
    assert.deepEqual(checkComponentUse([{ path: 'src/views/A/AView.vue', content: local }, { path: 'src/views/A/Field.vue', content: '<template><i /></template>' }], root), []);
    // v-model on a component with no model prop; a renamed import is still the common one
    const renamed = view('  <PopupOutlet v-model="open" />\n  <F :model="m" />', "import { PopupOutlet, Field as F } from '@/components'");
    assert.deepEqual(checkComponentUse([{ path: 'V.vue', content: renamed }], root).map((i) => i.message), [
      '<PopupOutlet> v-model를 받지 않음(modelValue prop 없음)',
      '<F> 필수 prop item 없음',
    ]);
    // no common components folder: nothing to check against
    assert.deepEqual(checkComponentUse([{ path: 'V.vue', content: renamed }], path.join(root, 'nope')), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A non-uni project: TS components, a "~" alias from tsconfig, barrels with export *.
function tsProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n2v-ts-project-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('tsconfig.json', '{\n  // comments are fine\n  "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["src/*"], }, },\n}\n');
  put('src/shared/ui/index.ts', "export * from './inputs'\nexport { default as AppDialog } from './AppDialog.vue'\nexport const SIZES = ['s', 'm']\n");
  put('src/shared/ui/inputs/index.ts', "import AppInput from './AppInput.vue'\nexport { AppInput }\n");
  put('src/shared/ui/inputs/AppInput.vue', '<script setup lang="ts">\ninterface Props {\n  label: string\n  // a comment: line\n  hint?: string\n  options: Array<{ a: number; b: string }>\n}\nconst props = withDefaults(defineProps<Props>(), { hint: \'\' })\nconst value = defineModel<string>({ required: true })\n</script>\n<template><input /></template>\n');
  put('src/shared/ui/AppDialog.vue', '<script setup lang="ts">\nimport type { PropType } from \'vue\'\ndefineProps({ title: { type: String as PropType<string>, required: true }, wide: Boolean })\ndefineModel<boolean>(\'open\')\n</script>\n<template><div /></template>\n');
  put('src/components/Legacy.vue', "<script>\nexport default { props: { code: { type: String, required: true } } }\n</script>\n<template><b /></template>\n");
  return root;
}

test('non-uni project: aliases from tsconfig, export * barrels, TS and Options API props', () => {
  const root = tsProject();
  try {
    const screen = [
      '<template>',
      '  <app-input v-model="name" :options="opts" />',
      '  <AppInput label="이름" v-model="name" :options="opts" />',
      '  <AppDialog v-model:open="open" />',
      '  <AppDialog v-model="open" title="t" />',
      '  <Legacy />',
      '  <ElButton type="primary" />',
      '</template>',
      '<script setup lang="ts">',
      "import { AppInput, AppDialog, SIZES } from '~/shared/ui'",
      "import Legacy from '~/components/Legacy.vue'",
      "import { ElButton } from 'element-plus'",
      "import type { Row } from '~/shared/ui'",
      "import { useUserApi } from './useUserApi'",
      '</script>',
    ].join('\n');
    const files = [{ path: 'src/pages/users/UserList.vue', content: screen }, { path: 'src/pages/users/useUserApi.ts', content: 'export const useUserApi = () => ({})\n' }];
    assert.deepEqual(checkComponentUse(files, root).map((i) => `${i.line} ${i.message}`), [
      '2 <app-input> 필수 prop label 없음',
      '4 <AppDialog> 필수 prop title 없음',
      '5 <AppDialog> v-model를 받지 않음(modelValue prop 없음)',
      '6 <Legacy> 필수 prop code 없음',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('imports that cannot load are caught: a name the barrel lacks, a component file that is not there', () => {
  const root = tsProject();
  try {
    const screen = [
      '<template><AppSelect /><SearchBox /><OtherScreen /></template>',
      '<script setup>',
      "import { AppInput, AppSelect } from '~/shared/ui'",
      "import SearchBox from '~/components/SearchBox.vue'",
      "import OtherScreen from '~/pages/orders/OrderPopup.vue'",
      "import { helper } from 'some-package'",
      '</script>',
    ].join('\n');
    assert.deepEqual(checkComponentUse([{ path: 'src/pages/users/UserList.vue', content: screen }], root).map((i) => `${i.line} ${i.component} ${i.message}`), [
      "3 AppSelect AppSelect는 '~/shared/ui'에 없는 export(이 화면이 아예 열리지 않음)",
      "4 SearchBox '~/components/SearchBox.vue' 파일이 프로젝트에 없음(이 화면이 아예 열리지 않음)",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TS type members: optional marks, nested types and comments', () => {
  const { typeMembers } = require('../src/component-check');
  assert.deepEqual(typeMembers("\n  a: string\n  'b-c'?: number; d: (x: number) => void\n  e: { f: string; g?: number }\n  h:\n    | 'x'\n    | 'y'\n"), [
    { name: 'a', optional: false }, { name: 'b-c', optional: true }, { name: 'd', optional: false }, { name: 'e', optional: false }, { name: 'h', optional: false },
  ]);
});
