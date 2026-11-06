'use strict';

const fs = require('fs');
const path = require('path');
const { listSources, readSource } = require('./scanner');
const { convertSources, PROFILES, NO_FORMS_MESSAGE } = require('./convert-core');
const { resolveNames, namesWithRoles } = require('./names');
const { detectRoles, normalizeRoles, withEdits } = require('./screen-roles');
const { aiConvertScreen, aiConvertScreenVue, aiFixScreen, claudeStatus, usageState, probeUsage, DEFAULT_TIMEOUT_MIN } = require('./ai-convert');
const { frontendKind } = require('./uni-structure');
const { checkComponentUse } = require('./component-check');
const { DEFAULT_UNI_FRONTEND } = require('./uni-preview-files');
const { isInside, realResolve, safeJoin } = require('./paths');
const { viewerFiles } = require('./viewer-scaffold');
const { uniPreviewFiles } = require('./uni-preview-scaffold');
const { vuePreviewFiles } = require('./vue-preview-scaffold');
const { makeShotDocs } = require('./shot-docs');

const RUNTIME_COMPAT = path.join(__dirname, '..', 'runtime', 'nexa-compat.js');

/**
 * Validate input/output folders. Output must never overlap the input so the
 * original sources can never be overwritten.
 */
function validateDirs(inputDir, outputDir) {
  if (!inputDir || !outputDir) throw new Error('입력 폴더와 출력 폴더를 모두 지정하세요');
  const input = realResolve(inputDir);
  const output = realResolve(outputDir);
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) throw new Error(`입력 폴더를 찾을 수 없습니다: ${inputDir}`);
  if (!path.isAbsolute(outputDir)) throw new Error('출력 폴더는 절대 경로여야 합니다 (예: D:\\vue-out)');
  if (path.parse(output).root === output) throw new Error('드라이브 최상위(예: D:\\)는 출력 폴더로 쓸 수 없습니다. 하위 폴더를 지정하세요');
  if (isInside(input, output) || isInside(output, input)) {
    throw new Error('출력 폴더는 입력 폴더와 같거나, 그 안에 있거나, 그것을 포함하면 안 됩니다 (원본 보호)');
  }
  return { input, output };
}

function loadConfig(inputDir) {
  const file = path.join(inputDir, 'nexa2vue.config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`nexa2vue.config.json 형식 오류: ${err.message}`);
  }
}

function preview(inputDir, outputDir, opts = {}) {
  const { input, output } = validateDirs(inputDir, outputDir);
  const { files, skipped } = listSources(input, opts);
  if (!files.some((f) => f.kind === 'form')) throw new Error(`${NO_FORMS_MESSAGE}: ${input}`);
  const formFiles = files.filter((f) => f.kind === 'form');
  const forms = formFiles.map((f) => f.rel);
  // Which screens are popups or sub-screens: guessed from the sources, for
  // review before conversion; opts.roles are the ones changed on the page.
  const detected = detectRoles(formFiles.map((f) => ({ rel: f.rel, text: readSource(f.abs).text })));
  const roles = normalizeRoles(forms, withEdits(detected, opts.roles));
  // Output name per screen: nexa2vue.config.json "names", else the role's default, else the file name.
  const { names } = resolveNames(forms, namesWithRoles(forms, loadConfig(input).names, roles));
  return {
    input,
    output,
    forms,
    roles,
    detected,
    names: Object.fromEntries(names),
    libs: files.filter((f) => f.kind === 'lib').map((f) => f.rel),
    skipped,
  };
}

/**
 * Convert every .xjs and .xfdl under inputDir (see convert-core.js). Files are
 * written only when dryRun is false.
 *
 * opts: { dryRun, uiOnly, viewer, profile, uniFrontend, uniBackend, renames, ai, aiModel, aiSkills, aiParallel, aiTimeout, aiFix, retryFailed, onProgress(fileResult, index, total), isCancelled() }
 * aiTimeout: minutes one screen's AI pass may take (else config.aiTimeout, default 20).
 * aiSkills: conversion-rules skill folders, in order (else config.aiSkill: a folder or a list of folders).
 * uniBackend: { root, basePackage } from the saved structure (uni-structure.js); when given, each screen also gets its backend under <output>/backend.
 * uniFrontend: uni frontend folder the uni style preview borrows from (default C:\uni_averedu\frontend).
 * profile: 'element' (default, keeps the absolute layout) or 'uni' (uni frontend
 * screen standard: View/Service/Constant re-laid out with the project's components).
 */
const REPORT_FILE = '_nexa2vue-report.json';

/**
 * The previous run's report in the output folder, for "AI 실패한 화면만 다시 변환".
 */
function loadPreviousReport(outputDir) {
  const file = path.join(outputDir, REPORT_FILE);
  if (!fs.existsSync(file)) throw new Error(`출력 폴더에 이전 변환 결과(${REPORT_FILE})가 없습니다. 변환 실행으로 처음부터 변환하세요`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${REPORT_FILE}를 읽을 수 없습니다: ${err.message}`);
  }
}

/**
 * retryFailed: convert again only the screens whose AI pass failed last time
 * (see convert-core.js retryFrom); the other screens' files stay as they are.
 */
async function runConversion(inputDir, outputDir, opts = {}) {
  const { input, output } = validateDirs(inputDir, outputDir);
  const { files, skipped } = listSources(input, opts);
  const sources = files.map((f) => ({ rel: f.rel, kind: f.kind, read: () => readSource(f.abs) }));
  const config = loadConfig(input);
  const uniFrontend = opts.uniFrontend || config.uniFrontend || DEFAULT_UNI_FRONTEND;
  // A frontend that is not uni: the screens are written the vue-convert skill's
  // way (convert-core.js vueMode) and previewed with that project's packages;
  // the uni backend follows the uni draft, so it is left out for now.
  const kind = opts.profile === 'uni' ? frontendKind(uniFrontend) : null;
  const uniBackend = opts.profile === 'uni' && opts.uniBackend && kind !== 'vue' ? opts.uniBackend : null;
  if (opts.retryFailed) opts = { ...opts, retryFrom: loadPreviousReport(output) };
  // Picks the signed-in Claude Code account the AI pass runs with.
  if (opts.ai || opts.shotDocs) await claudeStatus(config.claudePath);
  const report = await convertSources(sources, {
    frontendKind: kind,
    input,
    output,
    skipped,
    config,
    compatSource: fs.readFileSync(RUNTIME_COMPAT, 'utf8'),
    viewerFiles: opts.viewer ? viewerFiles(output) : [],
    uniPreviewFiles: opts.viewer && kind !== 'vue' ? uniPreviewFiles(opts.uniFrontend || config.uniFrontend) : [],
    vuePreviewFiles: opts.viewer && kind === 'vue' ? vuePreviewFiles(path.resolve(uniFrontend)) : [],
    write: (rel, content) => {
      const target = safeJoin(output, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    },
    exists: (rel) => fs.existsSync(safeJoin(output, rel)),
    // Before a screen's documents are written again: its pages and API/ in
    // docs/…/<화면ID>/ (images/ of the shot docs stay) and the single-file
    // document of older versions (docs/…/<화면ID>.html).
    // unlinkSync/rmdirSync, not rmSync: Node 24's fs.rmSync on Windows skips
    // Korean file names (01_개요.html) and can crash the process (0xC0000409).
    removeDocs: (dirRel, legacyRel) => {
      const isFile = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
      const isDir = (p) => fs.existsSync(p) && fs.statSync(p).isDirectory();
      const dir = safeJoin(output, dirRel);
      if (isDir(dir)) {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          if (/\.html$/i.test(name) && isFile(p)) fs.unlinkSync(p);
        }
        const apiDir = path.join(dir, 'API');
        if (isDir(apiDir)) {
          for (const name of fs.readdirSync(apiDir)) {
            const p = path.join(apiDir, name);
            if (isFile(p)) fs.unlinkSync(p);
          }
          // something else left in it (a folder someone put there): keep it
          if (!fs.readdirSync(apiDir).length) fs.rmdirSync(apiDir);
        }
      }
      const legacy = safeJoin(output, legacyRel);
      if (isFile(legacy)) fs.unlinkSync(legacy);
    },
    backend: uniBackend ? { basePackage: uniBackend.basePackage } : null,
    // How a screen uses the project's components (uni or any Vue project): AI
    // output, and the rule-based draft when that is what gets saved.
    checkFiles: kind ? (files) => checkComponentUse(files, uniFrontend) : null,
    // Last Claude usage reading (5-hour / 7-day %), the starting point of the usage shown per screen
    usageNow: usageState,
    // One tiny Claude call after the work: the "after" usage reading (see ai-convert probeUsage)
    usageProbe: opts.ai ? () => probeUsage({ claudeBin: config.claudePath }) : null,
    // One AI round that fixes just what the check caught (off with aiFix: false).
    aiFix: kind && opts.aiFix !== false ? ({ rel, files, checks, onStep, onUsage }) => aiFixScreen({
      relPath: rel,
      files,
      checks,
      frontendRoot: uniFrontend,
      model: opts.aiModel || config.aiModel,
      claudeBin: config.claudePath,
      timeoutMs: (Number(opts.aiTimeout || config.aiTimeout) || DEFAULT_TIMEOUT_MIN) * 60 * 1000,
      isCancelled: opts.isCancelled,
      onStep,
      onUsage,
    }) : null,
    // ai: Claude Code on this PC (config: claudePath, aiModel, aiSkill)
    aiConvert: ({ rel, text, draftFiles, draftBackendFiles, relations, previousChecks, onStep, onUsage }) => aiConvertScreen({
      onStep,
      onUsage,
      previousChecks,
      sourceText: text,
      relPath: rel,
      draftFiles,
      draftBackendFiles,
      relations,
      uniBackend: uniBackend && uniBackend.root,
      uniFrontend: opts.uniFrontend || config.uniFrontend || DEFAULT_UNI_FRONTEND,
      model: opts.aiModel || config.aiModel,
      skills: opts.aiSkills && opts.aiSkills.length ? opts.aiSkills : config.aiSkill,
      claudeBin: config.claudePath,
      timeoutMs: (Number(opts.aiTimeout || config.aiTimeout) || DEFAULT_TIMEOUT_MIN) * 60 * 1000,
      isCancelled: opts.isCancelled,
    }),
    aiConvertVue: ({ rel, text, relations, screen, previousChecks, onStep, onUsage }) => aiConvertScreenVue({
      onStep,
      onUsage,
      previousChecks,
      sourceText: text,
      relPath: rel,
      relations,
      screen,
      model: opts.aiModel || config.aiModel,
      skills: opts.aiSkills && opts.aiSkills.length ? opts.aiSkills : config.aiSkill,
      claudeBin: config.claudePath,
      timeoutMs: (Number(opts.aiTimeout || config.aiTimeout) || DEFAULT_TIMEOUT_MIN) * 60 * 1000,
      isCancelled: opts.isCancelled,
    }),
  }, opts);
  if (kind === 'vue' && opts.uniBackend && opts.onLog) opts.onLog('백엔드는 만들지 않았습니다: uni가 아닌 frontend로 변환할 때는 아직 백엔드를 함께 만들지 않습니다');

  // 선택: 변환이 끝나면 화면 설명 문서(캡처 + 번호별 설명)를 docs에 넣는다.
  // 실패해도 변환 결과는 그대로 두고 이유만 남긴다.
  if (opts.shotDocs && opts.profile === 'uni' && !opts.dryRun && !report.cancelled) {
    const onLog = opts.onLog || (() => {});
    try {
      const r = await makeShotDocs({
        output,
        uniFrontend,
        kind,
        report,
        claudeBin: config.claudePath,
        model: opts.aiModel || config.aiModel,
        parallel: Number(opts.aiParallel || config.aiParallel) || 3,
        isCancelled: opts.isCancelled,
        onLog,
        onUsage: opts.onUsage,
      });
      report.shotDocs = { done: r.done, failed: r.failed, costUsd: r.costUsd };
    } catch (err) {
      report.shotDocs = { error: err.message };
      onLog(`화면 설명 문서를 만들지 못했습니다: ${err.message}`);
      if (opts.isCancelled && opts.isCancelled()) report.cancelled = true;
    }
    fs.writeFileSync(path.join(output, REPORT_FILE), JSON.stringify(report, null, 2), 'utf8');
  }
  return report;
}

module.exports = { runConversion, preview, validateDirs, loadPreviousReport, PROFILES };
