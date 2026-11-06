#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { runConversion } = require('../src/job-runner');

function parseArgs(argv) {
  const args = { dryRun: false, aiSkills: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') args.input = argv[++i];
    else if (argv[i] === '--out') args.output = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--ui-only') args.uiOnly = true;
    else if (argv[i] === '--viewer') args.viewer = true;
    else if (argv[i] === '--shot-docs') args.shotDocs = true; // 변환 뒤 화면 설명 문서(캡처 + 번호별 설명), --profile uni --viewer 필요
    else if (argv[i] === '--profile') args.profile = argv[++i];
    else if (argv[i] === '--uni-frontend') args.uniFrontend = argv[++i];
    else if (argv[i] === '--names') args.namesFile = argv[++i];
    else if (argv[i] === '--ai') args.ai = true;
    else if (argv[i] === '--ai-model') args.aiModel = argv[++i];
    else if (argv[i] === '--ai-skill') args.aiSkills.push(argv[++i]); // repeatable, applied in order
    else if (argv[i] === '--ai-parallel') args.aiParallel = Number(argv[++i]);
    else if (argv[i] === '--ai-timeout') args.aiTimeout = Number(argv[++i]); // minutes per screen
    else if (argv[i] === '--no-ai-fix') args.aiFix = false; // no AI round for what the component check catches
    else if (argv[i] === '--retry-failed') args.retryFailed = true; // only screens whose AI pass failed last time (implies --profile uni --ai)
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input || !args.output) {
    console.log('Usage: nexa2vue --in <nexacro folder> --out <output folder> [--dry-run] [--ui-only] [--viewer] [--profile element|uni] [--uni-frontend <path>] [--names names.json] [--ai [--ai-model <model>] [--ai-skill <skill folder> ...] [--ai-parallel 3] [--ai-timeout 20] [--no-ai-fix]] [--retry-failed] [--shot-docs]');
    console.log('  --shot-docs     변환이 끝나면 미리보기로 화면을 캡처하고 Claude가 번호별 설명을 써서 docs 화면 문서에 넣음 (--profile uni --viewer 필요)');
    console.log('  --retry-failed  같은 출력 폴더의 지난 변환에서 AI가 실패한(사용 한도·시간 초과 등) 화면만 다시 변환 (--profile uni --ai 포함)');
    process.exit(args.help ? 0 : 1);
  }
  if (args.shotDocs && !args.viewer) throw new Error('--shot-docs는 --viewer와 함께 씁니다(미리보기로 캡처)');
  if (args.retryFailed && args.profile && args.profile !== 'uni') throw new Error('--retry-failed는 --profile uni에서만 씁니다');
  const report = await runConversion(args.input, args.output, {
    dryRun: args.dryRun,
    uiOnly: !!args.uiOnly,
    viewer: !!args.viewer,
    shotDocs: !!args.shotDocs,
    onLog: args.shotDocs ? (line) => /화면 설명|캡처|설명 작성|미리보기 서버/.test(line) && console.log(`  ${line}`) : undefined,
    profile: args.retryFailed ? 'uni' : args.profile,
    uniFrontend: args.uniFrontend,
    ai: !!args.ai || !!args.retryFailed,
    retryFailed: !!args.retryFailed,
    aiModel: args.aiModel,
    aiSkills: args.aiSkills,
    aiParallel: args.aiParallel,
    aiTimeout: args.aiTimeout,
    aiFix: args.aiFix !== false,
    onFileStart: (rel, stage) => stage === 'ai' && console.log(`  AI 변환 중: ${rel} (화면당 몇 분 걸릴 수 있음)`),
    // { "ua/usr/A.xfdl": "BAU0101010" }: output name per screen
    renames: args.namesFile ? JSON.parse(fs.readFileSync(args.namesFile, 'utf8')) : undefined,
    onProgress: (r, done, total) => console.log(`[${done}/${total}] ${r.status.padEnd(7)} ${r.input}${r.todos.length ? ` (TODO ${r.todos.length})` : ''}`),
  });
  const s = report.summary;
  if (report.retry) console.log(`\n다시 변환한 화면 ${report.retry.units.length}개: ${report.retry.units.join(', ')} (아래 합계는 전체 화면 기준)`);
  console.log(`\nok ${s.ok}, partial ${s.partial}, error ${s.error}, TODO ${s.todos}`);
  if (report.missingGfn.length) console.log(`gfn stubs to implement: ${report.missingGfn.join(', ')}`);
  if (!args.dryRun) console.log(`report: ${path.join(report.output, '_nexa2vue-report.json')}`);
  process.exit(s.error > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(`[nexa2vue] ${err.message}`);
  process.exit(1);
});
