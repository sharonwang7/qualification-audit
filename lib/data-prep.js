/**
 * data-prep.js - 数据准备层
 * 职责：下载附件、读取(文本PDF/DOCX 直读;图片/扫描PDF 调 ocr-paddle CLI)、构建标准化结果
 * 不处理任何业务逻辑，只做数据转换。
 *
 * OCR 已解耦到独立包 ocr-paddle(CLI 正门)。本层只负责:
 *   - 文本层 PDF / DOCX：本地直读(无模型,快)
 *   - 图片 / 扫描PDF：收集成 per-case 清单,一次性调 ocr-paddle(永不一文件一调)
 *   - .doc / 非标DOCX：需 LibreOffice 转换;未配置则标 failed → 交审核侧升级人工
 * 每个附件结果带 status(ok/empty/failed)+ low_conf + segments + engine,供审核侧放行门与置信度升级。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
// 2026-07-23：包一层默认注入 windowsHide:true——本文件 10+ 处 execFileSync(python/soffice/OCR/node)
//   在 Windows 下都会为子进程弹控制台黑窗（case 采集时成片弹）。此处统一隐藏，子进程照常运行；
//   调用方可显式传 windowsHide:false 覆盖（当前无此需要）。
const _cp_execFileSync = require('child_process').execFileSync;
const execFileSync = (file, args, opts = {}) => _cp_execFileSync(file, args, { windowsHide: true, ...opts });

// 配置
const ATTACH_DIR = process.env.QUAL_ATTACH_DIR || path.join(__dirname, '..', '..', 'fando-ocr-cache');
const PYTHON_BIN = process.env.QUAL_PYTHON_BIN || 'python';
// ocr-paddle CLI:默认按 skills 布局用 __dirname 解析(绝不靠 cwd),可用 QUAL_OCR_CLI 覆盖
const OCR_CLI = process.env.QUAL_OCR_CLI || path.resolve(__dirname, '..', '..', 'ocr-paddle', 'scripts', 'ocr.cjs');

// LibreOffice：.doc → docx、非标DOCX → pdf 的转换器(soffice.exe)。
// 2026-07-13 换机器可移植性修复：QUAL_SOFFICE_BIN 显式设置且存在 → 直接用(现有部署行为不变)；
// 否则依次探测常见安装目录 → PATH，找不到就 null（沿用既有"转人工"降级，不新增失败模式，只是让它在新机器上更可能自动跑起来）。
function resolveSofficeBin() {
  const envPath = process.env.QUAL_SOFFICE_BIN;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/lib/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const bin = process.platform === 'win32' ? 'soffice.exe' : 'soffice';
    const out = execFileSync(finder, [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    if (out && fs.existsSync(out)) return out;
  } catch (e) { /* PATH 里也没有，走下面兜底 */ }
  if (envPath) {
    console.error(`[qual-audit] 警告：QUAL_SOFFICE_BIN=${envPath} 不存在，自动探测也未找到 LibreOffice；.doc/非标DOCX 将转人工`);
  } else {
    console.error('[qual-audit] 提示：未设置 QUAL_SOFFICE_BIN，自动探测未找到 LibreOffice；.doc/非标DOCX 将转人工（如需支持，装 LibreOffice 或设 QUAL_SOFFICE_BIN 指向 soffice 可执行文件）');
  }
  return null;
}
const SOFFICE_BIN = resolveSofficeBin();

// LibreOffice 用户配置目录：QUAL_LO_PROFILE 显式设置则用它(现有部署行为不变)；
// 否则默认落系统临时目录(os.tmpdir())，不再假设 C:\temp 存在，跨机器/跨平台开箱可用。
function resolveLoProfile() {
  if (process.env.QUAL_LO_PROFILE) return process.env.QUAL_LO_PROFILE;
  const dir = path.join(os.tmpdir(), 'fando_lo_profile');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 已存在或无权限，交给 soffice 自己报错 */ }
  return 'file:///' + dir.replace(/\\/g, '/');
}
const LO_PROFILE = resolveLoProfile();
const MAX_PDF_SIZE_MB = 30;
// 图像/扫描PDF 识别模式：auto|vision = 标 needs_vision 交子代理 image()/pdf() 读(快+准)；
// paddle = 本地 ocr-paddle(离线/无 agent 视觉时的兜底，需 QUAL_OCR_MODE=paddle 显式开)。
const OCR_MODE = (process.env.QUAL_OCR_MODE || 'auto').toLowerCase();

// ===== 安全下载（P0-1 修复：命令注入）=====
function downloadSafe(url, outputPath, timeoutMs = 15000) {
  // URL 基础校验
  if (!url || typeof url !== 'string') {
    throw new Error('URL 为空或类型错误');
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    throw new Error(`URL 协议不安全: ${url.substring(0, 50)}`);
  }

  // 用 Node 自带 https/http 下载（不依赖 curl.exe；本机无 curl 会 spawnSync ENOENT）。
  // spawn 短命 node 子进程，父进程同步阻塞至完成；跟随重定向、二进制安全、不走系统代理。
  const dlScript = [
    'const https=require("https"),http=require("http"),fs=require("fs");',
    'const OUT=' + JSON.stringify(outputPath) + ',TIMEOUT=' + Number(timeoutMs) + ';',
    'const ws=fs.createWriteStream(OUT);',
    'function go(u,n){if(n>10){console.error("too many redirects");process.exit(4);}',
    'const mod=u.startsWith("https")?https:http;',
    'const req=mod.get(u,{timeout:TIMEOUT},res=>{',
    'if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();return go(new URL(res.headers.location,u).toString(),n+1);}',
    'if(res.statusCode!==200){console.error("HTTP "+res.statusCode);process.exit(5);}',
    'res.pipe(ws);ws.on("finish",()=>ws.close(()=>process.exit(0)));});',
    'req.on("error",e=>{console.error(e.message);process.exit(3);});',
    'req.on("timeout",()=>{req.destroy();console.error("timeout");process.exit(6);});}',
    'go(' + JSON.stringify(url) + ',0);'
  ].join('\n');
  execFileSync(process.execPath, ['-e', dlScript], { timeout: timeoutMs + 3000 });
}

// 504b0304 是 docx/xlsx/pptx/纯zip 的【通用】zip 签名——不能一律当 docx（旧 bug 致 xlsx/zip 被误判）。
// 进 zip 看内部条目定真实类型。无法窥探 → 当通用 .zip（交 expandZips 解包）。
function zipKind(filePath) {
  try {
    const py = [
      'import zipfile,sys',
      'sys.stdout.reconfigure(encoding="utf-8")',
      'n=zipfile.ZipFile(r"' + filePath.replace(/\\/g, '\\\\') + '").namelist()',
      'print("xlsx" if any(x.startswith("xl/") for x in n) else ("docx" if any(x.startswith("word/") for x in n) else ("pptx" if any(x.startswith("ppt/") for x in n) else "zip")))'
    ].join('\n');
    const out = execFileSync(PYTHON_BIN, ['-c', py], { encoding: 'utf8', timeout: 10000 }).trim();
    return out === 'xlsx' ? '.xlsx' : (out === 'pptx' ? '.pptx' : (out === 'docx' ? '.docx' : '.zip'));
  } catch (e) {
    return '.zip';
  }
}

function getFileTypeByHeader(filePath) {
  const header = fs.readFileSync(filePath, {encoding: null}).slice(0, 8);
  const hex = header.toString('hex');
  if (hex.startsWith('89504e47')) return '.png';
  if (hex.startsWith('ffd8')) return '.jpg';
  if (hex.startsWith('25504446')) return '.pdf';
  if (hex.startsWith('504b0304')) return zipKind(filePath); // 进 zip 看内部:xlsx/docx/pptx/zip
  if (hex.startsWith('d0cf11e0')) return '.doc';
  return '.bin';
}

// 2026-07-08 修复：原来只下载【字段名含「附件」】的字段 → 漏下「项目决策文档」等附件类字段
//   （米博有赞入驻件：新项目决策文档在「项目决策文档」字段、名字不含「附件」→ 从没进数据包 → 四要素没审）。
//   治本：字段名含「附件/决策文档/证件/证明材料」【或】字段值是飞书 drive 附件下载直链，都当附件下载。
//   drive 直链兜底最稳——任何上传的文件附件都带 internal-api-drive-stream .../stream/download，与 wiki/docx 链接可区分。
// 2026-07-09：业务可把「项目决策文档」等改成【文本形式直接贴云文档链接】(docx/wiki/sheets)。
//   云文档分享链不是文件下载直链，硬 downloadSafe 会抓到 HTML/失败 → 必须排除出文件下载队列，
//   改由 audit-tool 侧走 rawContent 抓正文（见 fetchCloudDocs）。两种提交形式（上传文件 / 文本链接）都能审。
const _isCloudDocLink = v => typeof v === 'string'
  && /\/(docx|docs|wiki|sheets)\/[A-Za-z0-9]/.test(v)
  && /(feishu\.cn|feishu\.net|larkoffice\.com|larksuite\.com)/.test(v);
function findAttachmentFields(formMap) {
  const urls = [];
  const nameHit = key => /附件|决策文档|证件|证明材料|截图/.test(key);
  const isDriveFile = v => typeof v === 'string' && /internal-api-drive-stream\.feishu\.cn\/.*stream\/download/.test(v);
  for (const [key, value] of Object.entries(formMap)) {
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) {
      // 云文档链接不当文件下（交 fetchCloudDocs 抓正文）；其余：字段名含附件类词 或 值是 drive 直链 → 下载
      if (typeof v === 'string' && v.startsWith('http') && !_isCloudDocLink(v) && (nameHit(key) || isDriveFile(v))) urls.push(v);
    }
  }
  return urls;
}
// 云文档链接（文本形式提交的附件类字段）→ 返回 [{field, url}]，交 audit-tool 抓 rawContent。
// 仅限附件类字段（决策文档/附件/证件/证明材料），避免把「说明」里的资质指引 wiki 链当成待审文档。
function findCloudDocLinks(formMap) {
  const nameHit = key => /附件|决策文档|证件|证明材料|截图/.test(key);
  const out = [];
  for (const [key, value] of Object.entries(formMap)) {
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) {
      if (typeof v === 'string' && v.startsWith('http') && _isCloudDocLink(v) && nameHit(key)) out.push({ field: key, url: v });
    }
  }
  return out;
}

function downloadAttachments(formMap, instanceCode) {
  const urls = findAttachmentFields(formMap);
  const dir = path.join(ATTACH_DIR, instanceCode.substring(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  const attachments = [];

  for (let i = 0; i < urls.length; i++) {
    const tmpPath = path.join(dir, `attach_${i+1}.tmp`);
    try {
      downloadSafe(urls[i], tmpPath, 15000);

      const ext = getFileTypeByHeader(tmpPath);
      const fpath = path.join(dir, `attach_${i+1}${ext}`);
      fs.renameSync(tmpPath, fpath);
      attachments.push({
        name: `attach_${i+1}${ext}`,
        path: fpath,
        size: fs.statSync(fpath).size
      });
    } catch(e) {
      console.error(`[DOWNLOAD_ERROR] 附件${i+1}下载失败:`, e.message);
      // 清理临时文件
      try { fs.unlinkSync(tmpPath); } catch {}
      // F8 fail-closed：下载失败不静默丢弃，留占位 → 计入 OCR 闸"证据缺失"，绝不被当"没这个附件"
      attachments.push({
        name: `attach_${i+1}`,
        download_failed: true,
        size: 0,
        error: { kind: 'download', message: (e.message || '').slice(0, 200), url_hint: String(urls[i]).slice(0, 80) }
      });
    }
  }
  return attachments;
}

// ===== 文本层 PDF 直读(无模型,快) =====
// 用"文本块覆盖页面面积占比"判断有没有真实文本层(旧的"数中文字"会被页眉水印骗过)。
// 返回 {hasText, content}。无文本层 → hasText=false,交由批量 OCR 处理。
function readPDFTextLayer(pdfPath) {
  try {
    // 逐页判定：每页按"文本块面积占比"或"实质字符数"判有无文字层。
    // 有文字层的页直接抽文本；无文字层的页(真图片页)记 index，交上层决定(混合件→标注/纯扫描→OCR)。
    const pyScript = `
import fitz, json, sys
pdf = fitz.open(r'${pdfPath.replace(/\\/g, '\\\\')}')
pages = []
parts = []
for i, page in enumerate(pdf):
    t = page.get_text()
    parea = page.rect.width * page.rect.height
    d = page.get_text('dict')
    tarea = 0.0
    for b in d.get('blocks', []):
        if b.get('type', 1) == 0:
            x0, y0, x1, y1 = b['bbox']
            tarea += max(0.0, x1 - x0) * max(0.0, y1 - y0)
    ratio = (tarea / parea) if parea else 0.0
    has = (ratio >= 0.03) or (len(t.strip()) >= 100)
    pages.append(has)
    if has:
        parts.append(t)
pdf.close()
meta = {'page_count': len(pages),
        'text_pages': [i for i, h in enumerate(pages) if h],
        'image_pages': [i for i, h in enumerate(pages) if not h]}
sys.stdout.write('__META__' + json.dumps(meta) + '\\n')
sys.stdout.write(''.join(parts)[:12000])
`;
    const out = execFileSync(PYTHON_BIN, ['-c', pyScript], { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const raw = out || '';
    let meta = { page_count: 0, text_pages: [], image_pages: [] };
    let body = raw;
    const mm = raw.match(/^__META__(\{[^\n]*\})\r?\n/);
    if (mm) { try { meta = JSON.parse(mm[1]); } catch (e) {} body = raw.slice(mm[0].length); }
    body = body.trim();
    const textPages = meta.text_pages || [];
    const imagePages = meta.image_pages || [];
    const hasText = textPages.length > 0 && body.length >= 100;
    return { hasText, content: body, pageCount: meta.page_count || 0, textPages, imagePages };
  } catch (e) {
    // 文本层探测失败 → 当作无文本层,交给 OCR(OCR 再失败会标 failed)
    return { hasText: false, content: '', pageCount: 0, textPages: [], imagePages: [], error: e.message };
  }
}

// 由逐页探测结果构造 PDF 附件结果：混合件用文本+标注图片页(不整份OCR)；全文字页直接用；纯扫描件返回 null(交 OCR)。
function pdfPreToResult(pre, source, type, sizeKb) {
  const imgPages = pre.imagePages || [];
  const txtPages = pre.textPages || [];
  if (imgPages.length > 0 && txtPages.length > 0) {
    const note = `\n\n[本 PDF 共 ${pre.pageCount} 页，第 ${imgPages.map(p => p + 1).join('/')} 页为图片(可能含印章/图样)，未OCR；如关键证据在这些页，需人工核对原件]`;
    return { source, type, content: (pre.content || '') + note, size_kb: sizeKb, status: 'ok', low_conf: false, segments: [], image_pages: imgPages };
  }
  if (pre.hasText) {
    return { source, type, content: pre.content, size_kb: sizeKb, status: 'ok', low_conf: false, segments: [] };
  }
  return null; // 纯扫描件(无任何文字层) → 交 OCR
}

// ===== DOCX 直读(无模型) =====
function readDOCX(docxPath) {
  try {
    const pyScript = `
import docx
doc = docx.Document(r'${docxPath.replace(/\\/g, '\\\\')}')
parts = [p.text for p in doc.paragraphs if p.text]
for tbl in doc.tables:
    for row in tbl.rows:
        for cell in row.cells:
            t = cell.text.strip()
            if t:
                parts.append(t)
text = '\\n'.join(parts)
print(text[:10000], end='')
`;
    const out = execFileSync(PYTHON_BIN, ['-c', pyScript], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024*1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const text = (out || '').trim();
    if (text.length >= 1) return { status: 'ok', content: text };
    // 读到空:可能是非标DOCX(内容在图片/文本框里),python-docx 取不到 → 标 empty 交审核侧
    return { status: 'empty', content: '[DOCX 直读为空，可能是非标DOCX(内容在图片/文本框)，需人工查看或转换]' };
  } catch (e) {
    return { status: 'failed', content: `[DOCX读取失败: ${e.message}]`, error: { kind: 'docx', message: e.message } };
  }
}

// ===== XLSX 直读(openpyxl → Markdown 表，无模型) =====
function readXLSX(xlsxPath) {
  try {
    const pyScript = `
import sys, openpyxl
sys.stdout.reconfigure(encoding='utf-8')
wb = openpyxl.load_workbook(open(r'${xlsxPath.replace(/\\/g, '\\\\')}', 'rb'), data_only=True, read_only=True)
out = []
for ws in wb.worksheets:
    out.append('## sheet: ' + str(ws.title))
    for row in ws.iter_rows(values_only=True):
        cells = ['' if c is None else str(c) for c in row]
        if any(x.strip() for x in cells):
            out.append(' | '.join(cells))
text = '\\n'.join(out)
print(text[:10000], end='')
`;
    const out = execFileSync(PYTHON_BIN, ['-c', pyScript], { encoding: 'utf8', timeout: 20000, maxBuffer: 4*1024*1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const text = (out || '').trim();
    if (text.length >= 1) return { status: 'ok', content: text };
    return { status: 'empty', content: '[XLSX 读取为空，需人工查看]' };
  } catch (e) {
    return { status: 'failed', content: `[XLSX读取失败: ${e.message}]`, error: { kind: 'xlsx', message: e.message } };
  }
}

// ===== LibreOffice 转换(.doc → docx；非标DOCX → pdf) =====
// soffice.exe 可能提前返回(不一定同步完成)，故 execFileSync 后再轮询输出文件；
// 失败返回 null → 上层走"转人工"。注:串行调用(per-case)共用一个 profile，足够。
function convertOffice(srcPath, toFormat) {
  if (!SOFFICE_BIN || !fs.existsSync(SOFFICE_BIN)) return null;
  const outDir = path.dirname(srcPath);
  const out = path.join(outDir, path.basename(srcPath, path.extname(srcPath)) + '.' + toFormat);
  const sleep = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {} };
  try {
    execFileSync(SOFFICE_BIN,
      ['-env:UserInstallation=' + LO_PROFILE, '--headless', '--norestore', '--convert-to', toFormat, '--outdir', outDir, srcPath],
      { timeout: 90000, stdio: 'ignore' });
  } catch (e) { /* 提前退出/超时 → 下面轮询兜底 */ }
  for (let i = 0; i < 24; i++) { // 再等最多 ~12s
    try { if (fs.existsSync(out) && fs.statSync(out).size > 0) return out; } catch (e) {}
    sleep(500);
  }
  return null;
}

function readUnknownAsText(filePath) {
  try {
    const buf = fs.readFileSync(filePath).slice(0, 2048);
    const text = buf.toString('utf-8', 0, 2048);
    const printable = text.replace(/[^ -~一-龥\n\r\t]/g, '');
    if (printable.length >= 30) {
      return { status: 'empty', content: printable.slice(0, 1000) };
    }
    return { status: 'failed', content: '[附件格式无法识别，需人工确认]', error: { kind: 'unknown_format' } };
  } catch (e) {
    return { status: 'failed', content: `[附件读取失败: ${e.message}]`, error: { kind: 'read', message: e.message } };
  }
}

// ===== 批量 OCR：一次性调 ocr-paddle CLI(模型只加载一次,跑完整批) =====
function runOcrBatch(files) {
  if (!files || files.length === 0) return { engine: null, results: [] };
  const tmp = path.join(ATTACH_DIR, `_ocr_manifest_${Date.now()}_${process.pid}.json`);
  try {
    fs.mkdirSync(ATTACH_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ files }), 'utf8');
    // 用当前 node(process.execPath,Windows 上稳)调 ocr.cjs;失败不抛,返回全 failed
    const out = execFileSync(process.execPath, [OCR_CLI, tmp], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 600000
    });
    const s = out.indexOf('{');
    return JSON.parse(s >= 0 ? out.slice(s) : out);
  } catch (e) {
    return {
      engine: null,
      results: files.map(f => ({
        file: f.path, kind: f.kind, status: 'failed', text: '', segments: [], low_conf: false,
        error: { kind: 'cli', message: (e.message || '').split('\n')[0].slice(0, 300) }
      }))
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

function ocrPlaceholder(r) {
  if (r && r.status === 'empty') return '[OCR未识别到有效文字(空白/纯图形/乱码)，需人工查看]';
  const kind = r && r.error && r.error.kind ? r.error.kind : 'unknown';
  return `[OCR失败(${kind})，需人工查看]`;
}

// ===== 扫描PDF 渲染成 PNG(供子代理 image()/pdf() 读;快,1~2s/页) =====
// 渲【前 headPages 页 + 末 tailPages 页】：合同签署页/双章在末尾，只渲前 N 页则永远看不到
// （2026-07-17 王爷定；#50/n=55 病灶：合同已上传、双章在末页 → 子代理只看到前 3 页 → 把"没验证"当"已满足"）。
// 返回 { paths, total, rendered }，rendered=实际渲染页码(1-based)，供上层明确告诉子代理"哪几页没看到"。
function renderPdfToPngs(pdfPath, headPages = 10, tailPages = 0) {
  try {
    const outDir = pdfPath + '_pages';
    const py = `
import fitz, os, sys, json
sys.stdout.reconfigure(encoding='utf-8')
os.makedirs(r'${outDir.replace(/\\/g, '\\\\')}', exist_ok=True)
pdf = fitz.open(r'${pdfPath.replace(/\\/g, '\\\\')}')
total = len(pdf)
head = list(range(min(${headPages}, total)))
tail = list(range(max(0, total - ${tailPages}), total)) if ${tailPages} > 0 else []
idxs = sorted(set(head + tail))
out = []
for i in idxs:
    p = os.path.join(r'${outDir.replace(/\\/g, '\\\\')}', f'page_{i+1}.png')
    pdf[i].get_pixmap(dpi=150).save(p); out.append(p)
pdf.close()
print(json.dumps({"paths": out, "total": total, "rendered": [i+1 for i in idxs]}))
`;
    const out = execFileSync(PYTHON_BIN, ['-c', py], { encoding: 'utf8', timeout: 120000, maxBuffer: 4*1024*1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }).trim();
    const o = JSON.parse(out.slice(out.indexOf('{')));
    return { paths: (o.paths || []).map(x => path.normalize(x)), total: o.total, rendered: o.rendered || [] }; // 规整双反斜杠(raw-string 副作用)
  } catch (e) { return null; }
}

// ===== ZIP 解包:把 zip 附件展开成内部文件，逐个再走分诊(图片/扫描PDF 仍进 OCR/视觉) =====
// 防 zip 炸弹:最多 200 个条目、总解压 ≤100MB。无法解包 → 留 failed 占位(不静默丢)。
function expandZips(attachments) {
  const out = [];
  for (const a of attachments) {
    if (a.download_failed || a.status || !a.path) { out.push(a); continue; }
    let ext = '.bin';
    try { ext = getFileTypeByHeader(a.path); } catch (e) {}
    if (ext !== '.zip') { out.push(a); continue; }
    const destDir = a.path + '_unzip';
    try {
      const py = `
import zipfile, os, json, sys
sys.stdout.reconfigure(encoding='utf-8')
z = zipfile.ZipFile(r'${a.path.replace(/\\/g, '\\\\')}')
names = [n for n in z.namelist() if not n.endswith('/')][:200]
total = 0; picked = []
for n in names:
    try: total += z.getinfo(n).file_size
    except Exception: pass
    if total > 100*1024*1024: break
    try:
        z.extract(n, r'${destDir.replace(/\\/g, '\\\\')}'); picked.append(n)
    except Exception: pass
print(json.dumps(picked))
`;
      const res = execFileSync(PYTHON_BIN, ['-c', py], { encoding: 'utf8', timeout: 60000, maxBuffer: 4*1024*1024 }).trim();
      const names = JSON.parse(res.slice(res.indexOf('[')));
      if (!names.length) { out.push({ name: a.name, path: a.path, size: a.size, status: 'failed', content: '[ZIP 为空或解包无内容，需人工查看]', error: { kind: 'zip_empty' } }); continue; }
      for (const n of names) {
        const p = path.join(destDir, n);
        try { out.push({ name: `${a.name}!${n}`, path: p, size: fs.statSync(p).size, _fromZip: a.name }); } catch (e) {}
      }
    } catch (e) {
      out.push({ name: a.name, path: a.path, size: a.size, status: 'failed', content: `[ZIP 解包失败: ${e.message}]`, error: { kind: 'zip', message: (e.message || '').slice(0, 200) } });
    }
  }
  return out;
}

// ===== 读取所有附件(两趟:先直读+分诊,再批量OCR) =====
function readAttachmentContent(attachments) {
  attachments = expandZips(attachments); // zip 先展开成内部文件，逐个走下面分诊
  const results = new Array(attachments.length);
  const ocrJobs = []; // { idx, path, kind }

  // 第一趟:分诊 + 直读
  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    const sizeKb = Math.round(a.size / 1024);
    // F8：下载失败占位 → 直接标 failed（无 path 可读），计入 OCR 闸"证据缺失"
    if (a.download_failed) {
      results[i] = { source: a.name, type: 'download_failed', content: '[附件下载失败，需人工核查原件]', size_kb: 0, status: 'failed', low_conf: false, segments: [], error: a.error };
      continue;
    }
    // 兼容 golden 用例：若附件已有 status 字段（如 status:'failed'），直接采用，不重新处理
    if (a.status) {
      results[i] = { source: a.source || a.name || `attach_${i+1}`, type: a.type || 'unknown', content: a.content || '', size_kb: sizeKb, status: a.status, low_conf: false, segments: [] };
      continue;
    }
    if (a.size / (1024 * 1024) > MAX_PDF_SIZE_MB) {
      results[i] = { source: a.name, type: 'oversized', content: `[文件过大 ${(a.size/1048576).toFixed(1)}MB，跳过读取，需人工查看]`, size_kb: sizeKb, status: 'failed', low_conf: false, error: { kind: 'oversize' } };
      continue;
    }
    const realExt = getFileTypeByHeader(a.path);
    if (realExt === '.pdf') {
      const pre = readPDFTextLayer(a.path);
      const r = pdfPreToResult(pre, a.name, 'pdf', sizeKb);
      if (r) { results[i] = r; }
      else { ocrJobs.push({ idx: i, path: a.path, kind: 'pdf' }); results[i] = { source: a.name, type: 'pdf', size_kb: sizeKb }; } // 纯扫描件→第二趟OCR
    } else if (realExt === '.docx') {
      const d = readDOCX(a.path);
      if (d.status === 'ok') {
        results[i] = { source: a.name, type: 'docx', content: d.content, size_kb: sizeKb, status: 'ok', low_conf: false, segments: [] };
      } else {
        // 非标DOCX(python-docx 读空,内容多在图片/文本框)→ LibreOffice 转 PDF → 文本层/OCR
        const pdf = convertOffice(a.path, 'pdf');
        if (pdf) {
          const pre = readPDFTextLayer(pdf);
          const r = pdfPreToResult(pre, a.name, 'docx', sizeKb);
          if (r) { results[i] = r; }
          else { ocrJobs.push({ idx: i, path: pdf, kind: 'pdf' }); results[i] = { source: a.name, type: 'docx', size_kb: sizeKb }; }
        } else {
          results[i] = { source: a.name, type: 'docx', content: d.content, size_kb: sizeKb, status: d.status, low_conf: false, segments: [], error: d.error };
        }
      }
    } else if (realExt === '.xlsx') {
      const x = readXLSX(a.path);
      results[i] = { source: a.name, type: 'xlsx', content: x.content, size_kb: sizeKb, status: x.status, low_conf: false, segments: [], error: x.error };
    } else if (realExt === '.png' || realExt === '.jpg') {
      ocrJobs.push({ idx: i, path: a.path, kind: 'image' });
      results[i] = { source: a.name, type: 'image', size_kb: sizeKb }; // 第二趟回填
    } else if (realExt === '.doc') {
      // 旧版二进制 .DOC：LibreOffice 转 docx 再读;转换失败 → 转人工(安全不漏)
      const conv = convertOffice(a.path, 'docx');
      if (conv) {
        const d = readDOCX(conv);
        results[i] = { source: a.name, type: 'doc', content: d.content, size_kb: sizeKb, status: d.status, low_conf: false, segments: [], error: d.error };
      } else {
        results[i] = { source: a.name, type: 'doc', content: '[旧版 .DOC 转换失败(LibreOffice 不可用) → 转人工]', size_kb: sizeKb, status: 'failed', low_conf: false, error: { kind: 'doc_convert_failed' } };
      }
    } else {
      const u = readUnknownAsText(a.path);
      results[i] = { source: a.name, type: 'unknown', content: u.content, size_kb: sizeKb, status: u.status, low_conf: false, error: u.error };
    }
  }

  // 第二趟:图片/扫描PDF 的识别
  if (ocrJobs.length > 0) {
    if (OCR_MODE === 'paddle') {
      // 离线/无视觉:本地 ocr-paddle 批量识别
      const ocr = runOcrBatch(ocrJobs.map(j => ({ path: j.path, kind: j.kind })));
      const engine = ocr.engine || null;
      for (let k = 0; k < ocrJobs.length; k++) {
        const job = ocrJobs[k];
        const r = (ocr.results || [])[k] || { status: 'failed', error: { kind: 'no_result' } };
        const content = (r.status === 'ok' && r.text) ? r.text : ocrPlaceholder(r);
        results[job.idx] = Object.assign(results[job.idx], {
          content, status: r.status || 'failed', low_conf: !!r.low_conf,
          segments: r.segments || [], seal_count: (r.seal_count === undefined ? null : r.seal_count), engine, error: r.error
        });
      }
    } else {
      // auto/vision：图片 → needs_vision(1张)；扫描PDF → 渲染【前 N 页 + 末 M 页】为图片 → needs_vision。
      //   （2026-07 第2步：原扫描PDF走 paddle【整份、无界】，30页大扫描拖垮整轮；现改【渲染(dpi150)交视觉，有界】。
      //    2026-07-17 加末 M 页：合同签署页/双章在末尾，只渲前 N 页永远验不到双章。
      //    前 N=QUAL_VISION_MAX_PAGES(默认3) + 末 M=QUAL_VISION_TAIL_PAGES(默认2)，按 case 封顶 QUAL_CASE_MAX_VISION(默认12)
      //    → 绝不撑爆子代理；paddle 降为渲染失败兜底。）
      const VISION_MAX_PAGES  = parseInt(process.env.QUAL_VISION_MAX_PAGES || '3', 10) || 3;   // 前 N 页
      const VISION_TAIL_PAGES = parseInt(process.env.QUAL_VISION_TAIL_PAGES || '2', 10) || 0;  // 末 M 页(签章区)
      const CASE_MAX_VISION   = parseInt(process.env.QUAL_CASE_MAX_VISION || '12', 10) || 12;
      const imgJobs = ocrJobs.filter(j => j.kind === 'image');
      const pdfJobs = ocrJobs.filter(j => j.kind === 'pdf');
      let visionUsed = 0; // 本 case 已投喂视觉的图数（含图片附件），按 CASE_MAX_VISION 封顶
      // 图片 → needs_vision（子代理 image() 读）
      for (const job of imgJobs) {
        results[job.idx] = Object.assign(results[job.idx], {
          status: 'needs_vision',
          content: '[待子代理用 image() 识别，图片见 vision_paths(1 张)]',
          vision_paths: [job.path], low_conf: false, segments: []
        });
        visionUsed += 1;
      }
      // 扫描PDF → 渲染前 N 页 + 末 M 页(dpi150) → needs_vision；渲染失败/预算满时降级
      for (const job of pdfJobs) {
        const budget = Math.max(0, CASE_MAX_VISION - visionUsed);
        const head = Math.min(VISION_MAX_PAGES, budget);
        const tail = Math.min(VISION_TAIL_PAGES, Math.max(0, budget - head));
        const r = head > 0 ? renderPdfToPngs(job.path, head, tail) : null;
        if (r && r.paths.length > 0) {
          visionUsed += r.paths.length;
          const missing = r.total - r.rendered.length;
          results[job.idx] = Object.assign(results[job.idx], {
            status: 'needs_vision',
            content: missing > 0
              ? `[扫描PDF 共 ${r.total} 页：已渲染第 ${r.rendered.join('/')} 页(dpi150，含末页签章区)交子代理视觉，见 vision_paths；其余 ${missing} 页未渲染，若关键条款在这些页需人工核对原件]`
              : `[扫描PDF 共 ${r.total} 页：已【全部】渲染(dpi150)交子代理视觉，见 vision_paths]`,
            vision_paths: r.paths, low_conf: false, segments: [], truncated_pages: missing > 0
          });
        } else if (head <= 0) {
          results[job.idx] = Object.assign(results[job.idx], {
            status: 'failed', low_conf: false, segments: [],
            content: '[扫描PDF：本 case 视觉预算已满(同 case 图过多)，未渲染，需人工核对原件]', error: { kind: 'vision_budget' }
          });
        } else {
          // 渲染失败 → 降级 ocr-paddle 兜底（保留离线能力）
          const ocr = runOcrBatch([{ path: job.path, kind: 'pdf' }]);
          const r = (ocr.results || [])[0] || { status: 'failed', error: { kind: 'no_result' } };
          const content = (r.status === 'ok' && r.text) ? r.text : ocrPlaceholder(r);
          results[job.idx] = Object.assign(results[job.idx], {
            content, status: r.status || 'failed', low_conf: !!r.low_conf,
            segments: r.segments || [], seal_count: (r.seal_count === undefined ? null : r.seal_count), engine: (ocr.engine || null), error: r.error
          });
        }
      }
    }
  }

  // F32 fail-closed：兜底确保每条结果都有 status（绝不 undefined），缺失即视为不可读，
  // 杜绝"无 status 被 OCR 闸当 ok 放行"。（golden 旧快照不经此函数，保留其向后兼容。）
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) {
      const nm = (attachments[i] && attachments[i].name) || `attach_${i + 1}`;
      results[i] = { source: nm, type: 'unknown', content: '[附件处理异常，未产出结果，需人工核查]', size_kb: 0, status: 'failed', low_conf: false, segments: [] };
    } else if (!results[i].status) {
      results[i].status = 'failed';
    }
  }

  return results;
}

// ===== 构建 Markdown Document Object（保留,透传新字段;主链由 audit-tool 直接用 readAttachmentContent）=====
function buildDocument(instanceCode, formMap, attachDocs) {
  return {
    metadata: {
      instance_code: instanceCode,
      processed_at: new Date().toISOString(),
      version: 'v3.0.0'
    },
    form: {
      reason: formMap['申请事由'] || '',
      quals: formMap['申请资质'] || [],
      brand: formMap['品牌'] || '',
      platform: formMap['使用平台'] || '',
      counterparty: formMap['资质流向方'] || '',
      company: formMap['公司主体'] || '',
      registry_no: formMap['提供注册号'] || formMap['注册号'] || '',
      contract_detail: formMap['合同明细'] || '',
      has_cooperation: formMap['是否跟对方存在合作关系'] || '',
      screenshot_attach: formMap['对方要求出具资质的截图附件'] || ''
    },
    attachments: (attachDocs || []).map(a => ({
      source: a.source,
      type: a.type,
      size_kb: a.size_kb,
      status: a.status,
      low_conf: a.low_conf,
      content: a.content
    }))
  };
}

// ===== 表单解析（兼容多种格式）=====
function parseForm(detail) {
  const d = detail.data || detail;
  if (!d.form) return {};

  let fields = [];
  if (Array.isArray(d.form)) {
    fields = d.form;
  } else if (typeof d.form === 'string') {
    try { fields = JSON.parse(d.form); } catch(e) {}
  } else if (typeof d.form === 'object') {
    const keys = Object.keys(d.form).sort((a,b) => parseInt(a)-parseInt(b));
    let raw = '';
    for (const k of keys) { if (typeof d.form[k] === 'string') raw += d.form[k]; }
    try { fields = JSON.parse(raw); } catch(e) {
      for (const k of keys) {
        try { const p = JSON.parse(d.form[k]); if (Array.isArray(p)) fields.push(...p); else fields.push(p); } catch(e2) {}
      }
    }
  }

  const map = {};
  for (const f of fields) { if (f && f.name) { map[f.name] = f.value; map[f.name.toLowerCase()] = f.value; } }
  map['公司主体'] = map['公司主体'] || map['公司主体1'] || map['主体公司'] || '';
  map['合同明细'] = map['合同明细'] || map['合同'] || '';
  map['是否跟对方存在合作关系'] = map['是否跟对方存在合作关系'] || map['是否合作关系'] || '';
  map['对方要求出具资质的截图附件'] = map['对方要求出具资质的截图附件'] || '';
  return map;
}

/**
 * 下载评论区附件到独立子目录，避免与表单附件混淆
 */
function downloadCommentAttachments(instanceCode, commentFiles) {
  if (!Array.isArray(commentFiles) || commentFiles.length === 0) return [];
  const dir = path.join(ATTACH_DIR, instanceCode.substring(0, 8), 'comments');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];

  for (let i = 0; i < commentFiles.length; i++) {
    const f = commentFiles[i];
    const tmpPath = path.join(dir, `comment_attach_${i+1}.tmp`);
    try {
      downloadSafe(f.url, tmpPath, 15000);
      const ext = getFileTypeByHeader(tmpPath);
      const fpath = path.join(dir, `comment_attach_${i+1}${ext}`);
      fs.renameSync(tmpPath, fpath);
      out.push({
        name: `comment_attach_${i+1}${ext}`,
        path: fpath,
        size: fs.statSync(fpath).size
      });
    } catch (e) {
      console.error(`[COMMENT_ATTACH_ERROR] ${f.name} 下载失败: ${e.message}`);
      try { fs.unlinkSync(tmpPath); } catch {}
      // F8 fail-closed：评论区附件下载失败同样留占位，计入 OCR 闸
      out.push({
        name: `comment_attach_${i+1}`,
        download_failed: true,
        size: 0,
        error: { kind: 'download', message: (e.message || '').slice(0, 200) }
      });
    }
  }
  return out;
}

module.exports = {
  downloadAttachments,
  downloadCommentAttachments,
  readAttachmentContent,
  buildDocument,
  parseForm,
  getFileTypeByHeader,
  findAttachmentFields,
  findCloudDocLinks
};
