'use strict';

// uni backend generator: one screen's Controller / Service / Mapper / Dto /
// Mapper.xml in the shape of the uni backend screen standard
// (backend/SCREEN_CONVENTION.md, NAMING_CONVENTION.md). The input is the API
// model the uni frontend generator built (gen-uni.js), so the names match
// across layers: findXxxList, saveXxxList, findXxxInfo, saveXxxInfo.
// Nexacro knows no tables: the table is guessed from the dataset token and the
// columns from the dataset, and every guess is marked with a TODO.

const DEFAULT_SCHEMA = 'UNI';
const DATE_TYPES = new Set(['DATE', 'DATETIME']);
const AUDIT_INSERT = [
  ['FRST_INPT_INDV_NO', '#{session.indvNo}'],
  ['FRST_INPT_DT', 'SYSDATE'],
  ['FRST_INPT_MENU_ID', '#{session.menuId}'],
  ['FRST_INPT_IP', '#{session.userIp}'],
  ['LAST_MDFCN_INDV_NO', '#{session.indvNo}'],
  ['LAST_MDFCN_DT', 'SYSDATE'],
  ['LAST_MDFCN_MENU_ID', '#{session.menuId}'],
  ['LAST_MDFCN_IP', '#{session.userIp}'],
];
const AUDIT_UPDATE = AUDIT_INSERT.slice(4);
// Audit and status columns come from CommonDto or the session, not the screen.
const SKIP_COLUMNS = new Set([...AUDIT_INSERT.map(([c]) => c), 'STATUS', 'ROWTYPE', '_ROWTYPE', 'CHK', 'CHK_YN']);

// stdNo -> STD_NO
function snake(field) {
  return String(field).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

function pad(s, n) {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

// Titles and labels are free Nexacro text but land in // and /** */ comments:
// one line, and no "*/" that would end the comment early.
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim();
}

// Inside <!-- -->: "--" is not allowed.
function xmlComment(s) {
  return oneLine(s).replace(/-(?=-)/g, '- ');
}

// Element text in Mapper.xml (the SQL ID comments).
function xmlText(s) {
  return oneLine(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield').split(' '));

// One folder name -> one Java package segment.
function packageSegment(s) {
  const seg = s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return !seg || /^[0-9]/.test(seg) || JAVA_KEYWORDS.has(seg) ? `_${seg}` : seg;
}

/** The model with every free-text field made one line (see oneLine). */
function cleanModel(model) {
  return {
    ...model,
    screenName: oneLine(model.screenName),
    search: model.search.map((s) => ({ ...s, label: oneLine(s.label) })),
    apis: model.apis.map((a) => ({ ...a, title: oneLine(a.title), columns: a.columns.map((c) => ({ ...c, label: oneLine(c.label) })) })),
  };
}

/** "편입생 목록" -> "편입생"; the target name used in comments. */
function targetName(title, token) {
  const t = String(title || '').replace(/\s*(목록|리스트|내역|정보|상세)$/, '').trim();
  return t || token;
}

/** Tables the APIs touch, in API order: { token, table, dsId, columns, pk, title }. */
function tablesOf(model) {
  const tables = new Map();
  for (const api of model.apis) {
    if (!tables.has(api.token)) {
      tables.set(api.token, {
        token: api.token,
        table: `${DEFAULT_SCHEMA}.${api.token.toUpperCase()}`,
        dsId: api.dsId,
        columns: api.columns.filter((c) => !SKIP_COLUMNS.has(c.col)),
        pk: api.pk.filter((f) => api.columns.some((c) => c.field === f)),
        title: targetName(api.title, api.token),
      });
    }
  }
  return [...tables.values()];
}

function tableTodo(t) {
  const from = t.dsId ? `넥사크로 Dataset(${xmlComment(t.dsId)})` : '화면 항목';
  return `<!-- TODO: 테이블 ${t.table}과 컬럼은 ${from}으로 추정한 것이라 테이블 설계 뒤에 맞춘다 -->`;
}

function selectExpr(c) {
  return c.date ? `TO_CHAR(A.${c.col}, 'YYYY-MM-DD') AS ${c.col}` : `A.${c.col}`;
}

function valueExpr(c) {
  return c.date ? `TO_DATE(#{${c.field}}, 'YYYY-MM-DD')` : `#{${c.field}}`;
}

/** WHERE lines and TODOs for the search conditions of a list lookup. */
function searchConditions(model, t) {
  const lines = [];
  const todos = [];
  const required = [];
  const optional = [];
  for (const s of model.search) {
    const c = t.columns.find((x) => x.field === s.key);
    if (!c) {
      todos.push(`<!-- TODO: ${xmlComment(s.label)} 조건(${xmlComment(s.key)})은 ${t.table}에 맞는 컬럼이 없어 테이블 설계 뒤에 만든다 -->`);
      continue;
    }
    const like = s.type === 'text' || s.type === 'textarea';
    const value = s.type === 'date' ? `TO_DATE(#{${s.key}}, 'YYYY-MM-DD')` : `#{${s.key}}`;
    const cond = like ? `A.${c.col} LIKE '%' || #{${s.key}} || '%'` : `A.${c.col} = ${value}`;
    (s.required ? required : optional).push({ s, cond });
  }
  if (required.length) {
    required.forEach((r, i) => lines.push(`     ${i ? '  AND' : 'WHERE'} ${r.cond}`));
  } else if (optional.length) {
    lines.push('     WHERE 1 = 1');
  }
  for (const o of optional) {
    lines.push(
      `      <if test="${o.s.key} != null and ${o.s.key} != ''">`,
      `       AND ${o.cond}`,
      '      </if>',
    );
  }
  return { lines, todos };
}

function sqlId(id, stmt, desc, edge) {
  return `    /* SQL ID: ${id}Mapper.${stmt} ${xmlText(desc)} ${edge} */`;
}

function selectList(model, t, name, dto) {
  const { lines: where, todos } = searchConditions(model, t);
  const cols = t.columns.length ? t.columns : [{ col: 'TODO_COLUMN', field: 'todoColumn' }];
  const order = t.pk.length ? t.pk.map(snake) : [cols[0].col];
  return [
    `  ${tableTodo(t)}`,
    ...todos.map((x) => `  ${x}`),
    `  <select id="${name}" parameterType="map" resultType="${dto}">`,
    sqlId(model.id, name, `${t.title} 조회`, '시작'),
    ...cols.map((c, i) => `    ${i ? '     , ' : 'SELECT '}${selectExpr(c)}`),
    `      FROM ${t.table} A`,
    ...where,
    `     ORDER BY ${order.map((c) => `A.${c}`).join(', ')}`,
    sqlId(model.id, name, `${t.title} 조회`, '종료'),
    '  </select>',
  ];
}

function selectInfo(model, t, name, dto) {
  const cols = t.columns.length ? t.columns : [{ col: 'TODO_COLUMN', field: 'todoColumn' }];
  const pk = t.pk.length ? t.pk : [cols[0].field];
  return [
    `  ${tableTodo(t)}`,
    `  <select id="${name}" parameterType="map" resultType="${dto}">`,
    sqlId(model.id, name, `${t.title} 조회`, '시작'),
    ...cols.map((c, i) => `    ${i ? '     , ' : 'SELECT '}${selectExpr(c)}`),
    `      FROM ${t.table} A`,
    ...pk.map((f, i) => `     ${i ? '  AND' : 'WHERE'} A.${snake(f)} = #{${f}}`),
    sqlId(model.id, name, `${t.title} 조회`, '종료'),
    '  </select>',
  ];
}

function pkTodo(t) {
  return `<!-- TODO: 키(${t.pk.map(snake).join(', ') || '없음'})는 추정값이라 테이블 설계 뒤에 맞춘다 -->`;
}

function writeStatements(model, t, dto) {
  const T = t.token;
  const cols = t.columns;
  const pk = t.pk.length ? t.pk : cols.slice(0, 1).map((c) => c.field);
  const nonPk = cols.filter((c) => !pk.includes(c.field));
  const insertCols = [...cols.map((c) => [c.col, valueExpr(c)]), ...AUDIT_INSERT];
  const width = Math.max(...[...nonPk.map((c) => c.col), ...AUDIT_UPDATE.map(([c]) => c)].map((c) => c.length));
  const updateSet = [...nonPk.map((c) => [c.col, valueExpr(c)]), ...AUDIT_UPDATE];
  const pkWidth = Math.max(...pk.map((f) => snake(f).length));
  const keyed = pk.map((f, i) => `     ${i ? '  AND' : 'WHERE'} ${pad(snake(f), pkWidth)} = #{${f}}`);
  // No key known (dataset without columns): never an UPDATE/DELETE of the whole table.
  const where = keyed.length ? keyed : ['     WHERE 1 = 0 /* TODO: 키 컬럼을 정한 뒤 조건을 만든다 */'];
  return [
    `  ${tableTodo(t)}`,
    `  <insert id="insert${T}Q01" parameterType="${dto}">`,
    sqlId(model.id, `insert${T}Q01`, `${t.title} 등록`, '시작'),
    '    INSERT',
    `      INTO ${t.table}`,
    ...insertCols.map(([c], i) => `         ${i ? ', ' : '( '}${c}`),
    '         )',
    '    VALUES',
    ...insertCols.map(([, v], i) => `         ${i ? ', ' : '( '}${v}`),
    '         )',
    sqlId(model.id, `insert${T}Q01`, `${t.title} 등록`, '종료'),
    '  </insert>',
    '',
    `  ${pkTodo(t)}`,
    `  <update id="update${T}Q01" parameterType="${dto}">`,
    sqlId(model.id, `update${T}Q01`, `${t.title} 수정`, '시작'),
    `    UPDATE ${t.table}`,
    ...updateSet.map(([c, v], i) => `       ${i ? '  , ' : 'SET '}${pad(c, width)} = ${v}`),
    ...where,
    sqlId(model.id, `update${T}Q01`, `${t.title} 수정`, '종료'),
    '  </update>',
    '',
    `  ${pkTodo(t)}`,
    `  <delete id="delete${T}Q01" parameterType="${dto}">`,
    sqlId(model.id, `delete${T}Q01`, `${t.title} 삭제`, '시작'),
    `    DELETE FROM ${t.table}`,
    ...where,
    sqlId(model.id, `delete${T}Q01`, `${t.title} 삭제`, '종료'),
    '  </delete>',
  ];
}

function searchLabels(model, t) {
  const labels = model.search.filter((s) => t.columns.some((c) => c.field === s.key)).map((s) => s.label);
  return labels.length ? `조회 조건(${labels.join('·')})` : '조회 조건';
}

/**
 * model: { id, dir, screenName, apis: [{ name, kind, token, dsId, title, columns: [{ col, field, label, date }], pk }], search: [{ key, label, type, required }] }
 * opts: { basePackage } (default kr.co.averedu)
 * Returns [{ path, content }] relative to the backend project root.
 */
function generateBackend(rawModel, opts = {}) {
  const model = cleanModel(rawModel);
  const base = opts.basePackage || 'kr.co.averedu';
  const dirPkg = model.dir ? model.dir.split('/').map(packageSegment).join('.') : 'screen';
  const pkg = `${base}.${dirPkg}`;
  const id = model.id;
  const dto = `${pkg}.dto.${id}Dto`;
  const screenName = model.screenName || id;
  const urlBase = `/api/${model.dir ? model.dir + '/' : ''}${id}`;
  const tables = tablesOf(model);
  const tableOf = (api) => tables.find((t) => t.token === api.token);
  const javaDir = `src/main/java/${pkg.replace(/\./g, '/')}`;

  // ---------------- Controller + Service (API order)
  const ctl = [];
  const svc = [];
  let usesList = false;
  let usesMap = false;
  let usesGet = false;
  let usesPost = false;
  for (const api of model.apis) {
    const t = tableOf(api);
    const name = api.name;
    const keyLabel = `조회 조건(${(t.pk.length ? t.pk : ['키']).join('·')})`;
    if (api.kind === 'findList') {
      usesList = usesMap = usesGet = true;
      ctl.push(
        '    /**', `     * ${t.title} 목록 조회`, `     * GET ${urlBase}/${name}`, `     * @param params ${searchLabels(model, t)}`, `     * @return ${t.title} 목록`, '     */',
        `    @GetMapping("/${name}")`,
        `    public List<${id}Dto> ${name}(@RequestParam Map<String, Object> params) {`,
        `        return service.${name}(params);`, '    }',
      );
      svc.push(
        '    /**', `     * ${t.title} 목록 조회`, `     * @param params ${searchLabels(model, t)}`, `     * @return ${t.title} 목록`, '     */',
        `    public List<${id}Dto> ${name}(Map<String, Object> params) {`,
        `        return mapper.${name}(params);`, '    }',
      );
    } else if (api.kind === 'findInfo') {
      usesMap = usesGet = true;
      ctl.push(
        '    /**', `     * ${t.title} 단건 조회`, `     * GET ${urlBase}/${name}`, `     * @param params ${keyLabel}`, `     * @return ${t.title}(없으면 빈 응답)`, '     */',
        `    @GetMapping("/${name}")`,
        `    public ${id}Dto ${name}(@RequestParam Map<String, Object> params) {`,
        `        return service.${name}(params);`, '    }',
      );
      svc.push(
        '    /**', `     * ${t.title} 단건 조회`, `     * @param params ${keyLabel}`, `     * @return ${t.title}(없으면 빈 응답)`, '     */',
        `    public ${id}Dto ${name}(Map<String, Object> params) {`,
        `        return mapper.${name}(params);`, '    }',
      );
    } else if (api.kind === 'saveList') {
      usesList = usesPost = true;
      const T = api.token;
      ctl.push(
        '    /**', `     * ${t.title} 목록 저장`, `     * POST ${urlBase}/${name}`, `     * @param saveRows 저장할 ${t.title} 목록`, '     */',
        `    @PostMapping("/${name}")`,
        `    public void ${name}(@RequestBody List<${id}Dto> saveRows) {`,
        `        service.${name}(saveRows);`, '    }',
      );
      svc.push(
        '    /**', `     * ${t.title} 목록 저장(상태값 I/U/D에 따라 등록·수정·삭제)`, `     * @param saveRows 저장할 ${t.title} 목록`, '     */',
        `    public void ${name}(List<${id}Dto> saveRows) {`,
        `        for (${id}Dto row : saveRows) {`,
        '            String status = row.getStatus();',
        '            switch (status) {',
        '                case "I":', `                    mapper.insert${T}Q01(row);`, '                    break;',
        '                case "U":', `                    mapper.update${T}Q01(row);`, '                    break;',
        '                case "D":', `                    mapper.delete${T}Q01(row);`, '                    break;',
        '                default:', '                    throw new IllegalArgumentException("지원하지 않는 행 상태입니다.");',
        '            }', '        }', '    }',
      );
    } else if (api.kind === 'saveInfo') {
      usesPost = true;
      const T = api.token;
      ctl.push(
        '    /**', `     * ${t.title} 저장`, `     * POST ${urlBase}/${name}`, `     * @param row 저장할 ${t.title}`, '     */',
        `    @PostMapping("/${name}")`,
        `    public void ${name}(@RequestBody ${id}Dto row) {`,
        `        service.${name}(row);`, '    }',
      );
      svc.push(
        '    /**', `     * ${t.title} 저장`, `     * @param row 저장할 ${t.title}`, '     */',
        `    public void ${name}(${id}Dto row) {`,
        '        // 있으면 수정, 없으면(수정 0건) 등록',
        `        if (mapper.update${T}Q01(row) == 0) {`,
        `            mapper.insert${T}Q01(row);`,
        '        }', '    }',
      );
    }
    ctl.push('');
    svc.push('');
  }
  if (ctl[ctl.length - 1] === '') ctl.pop();
  if (svc[svc.length - 1] === '') svc.pop();

  const springImports = [
    usesGet && 'org.springframework.web.bind.annotation.GetMapping',
    usesPost && 'org.springframework.web.bind.annotation.PostMapping',
    usesPost && 'org.springframework.web.bind.annotation.RequestBody',
    'org.springframework.web.bind.annotation.RequestMapping',
    usesGet && 'org.springframework.web.bind.annotation.RequestParam',
    'org.springframework.web.bind.annotation.RestController',
  ].filter(Boolean);
  const utilImports = [usesList && 'java.util.List', usesMap && 'java.util.Map'].filter(Boolean);
  const importBlock = (...groups) => groups.filter((g) => g.length).map((g) => g.map((i) => `import ${i};`).join('\n')).join('\n\n');

  const controller = [
    `package ${pkg}.controller;`, '',
    importBlock(utilImports, springImports, [`${pkg}.dto.${id}Dto`, `${pkg}.service.${id}Service`, 'lombok.RequiredArgsConstructor']), '',
    `/** ${screenName} 컨트롤러 */`,
    '@RestController',
    `@RequestMapping("${urlBase}")`,
    '@RequiredArgsConstructor',
    `public class ${id}Controller {`, '',
    `    private final ${id}Service service;`,
    ...(ctl.length ? ['', ...ctl] : []),
    '}', '',
  ].join('\n');

  const service = [
    `package ${pkg}.service;`, '',
    importBlock(utilImports, ['org.springframework.stereotype.Service', 'org.springframework.transaction.annotation.Transactional'],
      [`${pkg}.dto.${id}Dto`, `${pkg}.mapper.${id}Mapper`, 'lombok.RequiredArgsConstructor']), '',
    `/** ${screenName} 서비스 */`,
    '@Service',
    '@Transactional',
    '@RequiredArgsConstructor',
    `public class ${id}Service {`, '',
    `    private final ${id}Mapper mapper;`,
    ...(svc.length ? ['', ...svc] : []),
    '}', '',
  ].join('\n');

  // ---------------- Mapper interface + XML (per table: lookup, insert, update, delete)
  const mapperMethods = [];
  const xml = [];
  const writesDone = new Set();
  let mapperUsesList = false;
  let mapperUsesMap = false;
  const pushXml = (lines) => {
    if (xml.length) xml.push('');
    xml.push(...lines);
  };
  for (const api of model.apis) {
    const t = tableOf(api);
    if (api.kind === 'findList') {
      mapperUsesList = mapperUsesMap = true;
      mapperMethods.push(`    /** ${t.title} 목록 조회 */`, `    List<${id}Dto> ${api.name}(Map<String, Object> params);`, '');
      pushXml(selectList(model, t, api.name, dto));
    } else if (api.kind === 'findInfo') {
      mapperUsesMap = true;
      mapperMethods.push(`    /** ${t.title} 단건 조회 */`, `    ${id}Dto ${api.name}(Map<String, Object> params);`, '');
      pushXml(selectInfo(model, t, api.name, dto));
    } else if ((api.kind === 'saveList' || api.kind === 'saveInfo') && !writesDone.has(t.token)) {
      writesDone.add(t.token);
      const T = t.token;
      mapperMethods.push(
        `    /** ${t.title} 등록 */`, `    int insert${T}Q01(${id}Dto row);`, '',
        `    /** ${t.title} 수정 */`, `    int update${T}Q01(${id}Dto row);`, '',
        `    /** ${t.title} 삭제 */`, `    int delete${T}Q01(${id}Dto row);`, '',
      );
      pushXml(writeStatements(model, t, dto));
    }
  }
  if (mapperMethods[mapperMethods.length - 1] === '') mapperMethods.pop();

  const mapper = [
    `package ${pkg}.mapper;`, '',
    importBlock([mapperUsesList && 'java.util.List', mapperUsesMap && 'java.util.Map'].filter(Boolean), ['org.apache.ibatis.annotations.Mapper'], [`${pkg}.dto.${id}Dto`]), '',
    `/** ${screenName} 매퍼 */`,
    '@Mapper',
    `public interface ${id}Mapper {`,
    ...mapperMethods,
    '}', '',
  ].join('\n');

  const mapperXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE mapper',
    '  PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN"',
    '  "http://mybatis.org/dtd/mybatis-3-mapper.dtd">',
    '',
    `<mapper namespace="${pkg}.mapper.${id}Mapper">`,
    '',
    ...xml,
    '</mapper>', '',
  ].join('\n');

  // ---------------- Dto: one section per table, each field once
  const seen = new Set();
  const sections = [];
  for (const t of tables) {
    const fields = t.columns.filter((c) => !seen.has(c.field));
    fields.forEach((c) => seen.add(c.field));
    if (fields.length) sections.push({ t, fields });
  }
  const fieldLine = (c) => `    private String ${c.field};`;
  const width = Math.max(0, ...sections.flatMap((s) => s.fields.map((c) => fieldLine(c).length))) + 1;
  const dtoBody = [];
  sections.forEach((s, i) => {
    if (i) dtoBody.push('');
    dtoBody.push(`    // ${s.t.table} 테이블 컬럼`);
    for (const c of s.fields) {
      const label = c.label && c.label !== c.field ? c.label : c.col;
      dtoBody.push(`${pad(fieldLine(c), width)}// ${label}${c.date ? '(YYYY-MM-DD)' : ''}`);
    }
  });
  const dtoFile = [
    `package ${pkg}.dto;`, '',
    importBlock([`${base}.common.dto.CommonDto`, 'lombok.Data', 'lombok.EqualsAndHashCode']), '',
    `/** ${screenName} DTO */`,
    '@Data',
    '@EqualsAndHashCode(callSuper = true)',
    `public class ${id}Dto extends CommonDto {`,
    ...dtoBody,
    '}', '',
  ].join('\n');

  return [
    { path: `${javaDir}/controller/${id}Controller.java`, content: controller },
    { path: `${javaDir}/service/${id}Service.java`, content: service },
    { path: `${javaDir}/mapper/${id}Mapper.java`, content: mapper },
    { path: `${javaDir}/dto/${id}Dto.java`, content: dtoFile },
    { path: `src/main/resources/mapper/${model.dir ? model.dir + '/' : ''}${id}Mapper.xml`, content: mapperXml },
  ];
}

module.exports = { generateBackend, snake, DATE_TYPES, SKIP_COLUMNS };
