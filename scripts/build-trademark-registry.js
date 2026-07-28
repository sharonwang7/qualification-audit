/**
 * Build trademark-registry-full.json from all 7 bitable tables
 * Data verified against actual feishu bitable API responses (2026-06-23)
 */
const fs = require('fs');
const path = require('path');

// ===== Read existing 慕可 data =====
const existingPath = path.join(__dirname, 'trademark-registry.json');
let existingMukeTrademarks = [];
try {
  let raw = fs.readFileSync(existingPath, 'utf8');
  raw = raw.replace(/^#.*[\r\n]*/gm, '').trim();
  const parsed = JSON.parse(raw);
  existingMukeTrademarks = (parsed.trademarks || []).map(t => ({
    name: (t.name || '').trim(),
    reg_no: String(t.reg_no || '').trim(),
    class: String(t.category || t.class || '').replace(/\.0$/, ''),
    brand: (t.brand || '').trim()
  }));
  console.log(`Loaded ${existingMukeTrademarks.length} existing 慕可 trademarks`);
} catch(e) {
  console.error('Failed to read existing file:', e.message);
}

// ===== Helper =====
function processRecords(rawArray) {
  const seen = new Set();
  const result = [];
  for (const row of rawArray) {
    const name = String(row[0]).trim();
    const regNo = String(row[1] || '').trim();
    const cls = String(row[2] || '').replace(/\.0$/, '');
    const brand = String(row[3]).trim();
    if (!regNo) continue;
    if (seen.has(regNo)) continue;
    seen.add(regNo);
    result.push({ name, reg_no: regNo, class: cls, brand });
  }
  return result;
}

// ===== TABLE 1: 凡岛网络 (tblwlp57lZCiJTFQ) - 103 records verified from API =====
// API filter: 商标状态=已注册下证, fields: 商标名称, 申请 注册号, 国际分类, 所属品牌
const fandaoRaw = [
  // -- WIS brand (16 records) --
  ["+WIS+实验室", "56896430", "3", "WIS"],
  ["WIS PROFESSIONAL", "43347372", "3", "WIS"],
  ["WISWEN", "37968902", "3", "WIS"],
  ["WIS", "37009271", "3", "WIS"],
  ["WISMAN", "23544946", "3", "WIS"],
  ["WIS PLUS", "23035541", "3", "WIS"],
  ["+WIS+ PROFESSIONAL", "19125512", "3", "WIS"],
  ["WIS", "7629781", "3", "WIS"],
  ["+WIS+实验室", "56897609", "35", "WIS"],
  ["WISWAN", "37970876", "35", "WIS"],
  ["WISWAN", "37970087", "24", "WIS"],
  ["WISWAN", "37965263", "16", "WIS"],
  ["WISWAN", "37962280", "1", "WIS"],
  ["WISWAN", "37959977", "5", "WIS"],
  ["WISWAN", "37949908", "9", "WIS"],
  ["给自己最好的 WIS", "15229489", "3", "WIS"],
  // -- FANDOW 凡岛 brand (48 records) --
  ["WTEAM", "37005421", "41", "FANDOW 凡岛"],
  ["FANDOW", "36912583", "30", "FANDOW 凡岛"],
  ["FANDOW", "36912418", "21", "FANDOW 凡岛"],
  ["FANDOW", "36907993", "7", "FANDOW 凡岛"],
  ["FANDOW", "36907654", "20", "FANDOW 凡岛"],
  ["FANDOW", "36906809", "9", "FANDOW 凡岛"],
  ["FANDOW", "36906133", "28", "FANDOW 凡岛"],
  ["FANDOW", "36904873", "36", "FANDOW 凡岛"],
  ["FANDOW", "36902715", "12", "FANDOW 凡岛"],
  ["FANDOW", "36902554", "8", "FANDOW 凡岛"],
  ["FANDOW", "36902473", "39", "FANDOW 凡岛"],
  ["FANDOW", "36902430", "37", "FANDOW 凡岛"],
  ["FANDOW", "36901109", "25", "FANDOW 凡岛"],
  ["FANDOW", "36895125", "40", "FANDOW 凡岛"],
  ["FANDOW", "36894878", "11", "FANDOW 凡岛"],
  ["FANDOW", "36894767", "41", "FANDOW 凡岛"],
  ["FANDOW", "36893553", "13", "FANDOW 凡岛"],
  ["FANDOW", "36889836", "16", "FANDOW 凡岛"],
  ["FANDOW", "36889680", "43", "FANDOW 凡岛"],
  ["FANDOW", "36889612", "38", "FANDOW 凡岛"],
  ["FANDOW", "36887699", "10", "FANDOW 凡岛"],
  ["FANDOW", "36886597", "24", "FANDOW 凡岛"],
  ["FANDOW", "36726433", "44", "FANDOW 凡岛"],
  ["凡岛", "36723838", "33", "FANDOW 凡岛"],
  ["FANDOW", "36722338", "33", "FANDOW 凡岛"],
  ["凡岛", "36720506", "35", "FANDOW 凡岛"],
  ["凡岛", "36719690", "44", "FANDOW 凡岛"],
  ["FANDOW", "36715703", "34", "FANDOW 凡岛"],
  ["FANDOW", "36712508", "5", "FANDOW 凡岛"],
  ["凡岛", "36712290", "45", "FANDOW 凡岛"],
  ["凡岛", "36704658", "34", "FANDOW 凡岛"],
  ["凡岛", "36703523", "42", "FANDOW 凡岛"],
  ["凡岛", "36674180", "31", "FANDOW 凡岛"],
  ["凡岛", "36673062", "22", "FANDOW 凡岛"],
  ["FANDOW", "36673021", "19", "FANDOW 凡岛"],
  ["FANDOW", "36671546", "15", "FANDOW 凡岛"],
  ["FANDOW", "36670397", "27", "FANDOW 凡岛"],
  ["凡岛", "36670372", "26", "FANDOW 凡岛"],
  ["凡岛", "36668551", "32", "FANDOW 凡岛"],
  ["凡岛", "36668488", "29", "FANDOW 凡岛"],
  ["凡岛", "36668446", "27", "FANDOW 凡岛"],
  ["凡岛", "36668385", "23", "FANDOW 凡岛"],
  ["FANDOW", "36666496", "29", "FANDOW 凡岛"],
  ["FANDOW", "36664757", "23", "FANDOW 凡岛"],
  ["FANDOW", "36663298", "32", "FANDOW 凡岛"],
  ["FANDOW", "36661599", "31", "FANDOW 凡岛"],
  ["凡岛", "36660067", "19", "FANDOW 凡岛"],
  ["凡岛", "36660047", "17", "FANDOW 凡岛"],
  // -- KONO brand (12 records) --
  ["KONO", "56896044", "3", "KONO"],
  ["KONO", "43342678", "3", "KONO"],
  ["KONO", "37967302", "3", "KONO"],
  ["KONO", "7621142", "3", "KONO"],
  ["KONO PROFESSIONAL", "43345221", "3", "KONO"],
  ["KONO", "56897445", "35", "KONO"],
  ["KONO", "37968990", "35", "KONO"],
  ["KONO", "37961815", "1", "KONO"],
  ["KONO", "37956880", "5", "KONO"],
  ["KONO", "37952750", "9", "KONO"],
  ["KONO", "37946914", "24", "KONO"],
  ["KONO", "37943532", "16", "KONO"],
  // -- 赫系 brand (10 records) --
  ["赫系", "56897214", "3", "赫系"],
  ["赫系", "43339563", "3", "赫系"],
  ["赫系", "37965756", "3", "赫系"],
  ["赫系", "56897657", "35", "赫系"],
  ["赫系", "37973868", "35", "赫系"],
  ["赫系", "37973855", "1", "赫系"],
  ["赫系", "37969476", "5", "赫系"],
  ["赫系", "37965731", "9", "赫系"],
  ["赫系", "37960042", "24", "赫系"],
  ["赫系", "37956465", "16", "赫系"],
  // -- IRY brand (10 records) --
  ["IRY", "56896298", "3", "IRY"],
  ["IRY", "43342228", "3", "IRY"],
  ["IRY", "37963720", "3", "IRY"],
  ["IRY", "56897684", "35", "IRY"],
  ["IRY", "37967467", "35", "IRY"],
  ["IRY", "37961805", "1", "IRY"],
  ["IRY", "37956831", "5", "IRY"],
  ["IRY", "37950444", "9", "IRY"],
  ["IRY", "37947064", "24", "IRY"],
  ["IRY", "37943580", "16", "IRY"],
  // -- 可麦 brand (10 records) --
  ["可麦", "56897087", "3", "可麦"],
  ["可麦", "43343667", "3", "可麦"],
  ["可麦", "37962575", "3", "可麦"],
  ["可麦", "56897968", "35", "可麦"],
  ["可麦", "37967632", "35", "可麦"],
  ["可麦", "37961800", "1", "可麦"],
  ["可麦", "37956875", "5", "可麦"],
  ["可麦", "37950489", "9", "可麦"],
  ["可麦", "37946976", "24", "可麦"],
  ["可麦", "37943366", "16", "可麦"],
  // -- 墨雪 brand (4 records) --
  ["墨雪", "58586294", "3", "墨雪"],
  ["墨雪", "39852737", "3", "墨雪"],
  ["墨雪", "7957668", "3", "墨雪"],
  ["墨雪", "73128808", "3", "墨雪"],
  // -- 魔渍 brand (10 records) --
  ["魔渍", "56896186", "3", "魔渍"],
  ["魔渍", "43340596", "3", "魔渍"],
  ["魔渍", "37963635", "3", "魔渍"],
  ["魔渍", "56897783", "35", "魔渍"],
  ["魔渍", "37967536", "35", "魔渍"],
  ["魔渍", "37961810", "1", "魔渍"],
  ["魔渍", "37956845", "5", "魔渍"],
  ["魔渍", "37950428", "9", "魔渍"],
  ["魔渍", "37947015", "24", "魔渍"],
  ["魔渍", "37943407", "16", "魔渍"],
  // -- 森益 brand (10 records) --
  ["森益", "56896780", "3", "森益"],
  ["森益", "43338634", "3", "森益"],
  ["森益", "37959659", "3", "森益"],
  ["森益", "56897838", "35", "森益"],
  ["森益", "37970896", "35", "森益"],
  ["森益", "37961788", "1", "森益"],
  ["森益", "37956852", "5", "森益"],
  ["森益", "37950402", "9", "森益"],
  ["森益", "37946935", "24", "森益"],
  ["森益", "37943191", "16", "森益"],
  // -- MVE brand (10 records) --
  ["MVE", "56896601", "3", "MVE"],
  ["MVE", "43340716", "3", "MVE"],
  ["MVE", "37964537", "3", "MVE"],
  ["MVE", "56897796", "35", "MVE"],
  ["MVE", "37967617", "35", "MVE"],
  ["MVE", "37961760", "1", "MVE"],
  ["MVE", "37956866", "5", "MVE"],
  ["MVE", "37950468", "9", "MVE"],
  ["MVE", "37946994", "24", "MVE"],
  ["MVE", "37943389", "16", "MVE"],
];

// From API: FANDOW brand continues (verified in tail of response):
const fandaoTail = [
  ["FANDOW", "36659036", "22", "FANDOW 凡岛"],
  ["FANDOW", "36654707", "17", "FANDOW 凡岛"],
  ["FANDOW", "36654545", "26", "FANDOW 凡岛"],
  ["凡岛", "36623224", "1", "FANDOW 凡岛"],
  ["凡岛", "36620864", "14", "FANDOW 凡岛"],
  ["凡岛", "36620266", "4", "FANDOW 凡岛"],
  ["FANDOW", "36620108", "2", "FANDOW 凡岛"],
  ["凡岛", "36616450", "7", "FANDOW 凡岛"],
  ["凡岛", "36615219", "2", "FANDOW 凡岛"],
  ["凡岛", "36609807", "13", "FANDOW 凡岛"],
  ["凡岛", "36608656", "12", "FANDOW 凡岛"],
  ["凡岛", "36605015", "6", "FANDOW 凡岛"],
  ["凡岛", "36604850", "3", "FANDOW 凡岛"],
  ["凡岛", "17007541", "42", "FANDOW 凡岛"],
  ["FANDOW", "17007439", "42", "FANDOW 凡岛"],
  ["凡岛", "17007265", "35", "FANDOW 凡岛"],
  ["FANDOW", "17007153", "35", "FANDOW 凡岛"],
  ["FANDOW", "36914616", "14", "FANDOW 凡岛"],
  ["凡岛", "36911415", "21", "FANDOW 凡岛"],
  ["凡岛", "36911227", "9", "FANDOW 凡岛"],
  // Misc verified from tail
  ["图形", "39847027", "3", "其他"],
  ["2W", "18826032", "42", "其他"],
  ["2W", "18825615", "9", "其他"],
  ["2W", "18825382", "41", "其他"],
  ["图形", "18811228", "3", "其他"],
  ["WTEAM", "37020743", "42", "WTEAM"],
  ["慕可", "12373370", "35", "慕可"],
  ["慕可", "12373338", "3", "慕可"],
];

const allFandaoRaw = [...fandaoRaw, ...fandaoTail];
console.log(`凡岛 raw: ${allFandaoRaw.length} entries`);

// ===== TABLE 2: 欣芝妍 (tblVCT3lSFLEBqIJ) - 7 records verified from API =====
const xinzhiyanRaw = [
  ["羊淘淘", "34464502", "35", "其他"],
  ["云狸家", "34478846", "35", "其他"],
  ["云狸购", "34461732", "35", "其他"],
  ["米可派", "33704980", "35", "其他"],
  ["BOOFINA", "38324759", "3", "其他"],
  ["MAiDAiFU 麦大夫", "16535090", "25", "其他"],
  ["SINLACE", "16649588", "3", "其他"],
];

// ===== TABLE 3: 橙子网络 (tblG4S7AnyJAUTtk) - 1 record =====
const chengziRaw = [
  ["微橙", "17006138", "35", "其他"],
];

// ===== TABLE 4: 凡岛投资 (tbluHJ5YZYxjx4u4) - 3 records =====
const fandaoTzRaw = [
  ["仑跃", "27904494", "25", "其他"],
  ["醒风", "22441052", "25", "其他"],
  ["醒风", "22440962", "42", "其他"],
];

// ===== TABLE 5: 海外商标统计 (tblyFnnJVazQx0Uy) - verified from API =====
const overseasData = [
  // +WIS+ -- 已下证
  {name:"+WIS+", country:"美国", brand:"WIS", entity:"凡岛", status:"已下证", reg_no:"8168898", class:"3"},
  {name:"+WIS+", country:"英国", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"018069740", class:"3"},
  {name:"+WIS+", country:"瑞士", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"749300", class:"3"},
  {name:"+WIS+", country:"欧盟", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"018069740", class:"3"},
  {name:"+WIS+", country:"俄罗斯", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"766746", class:"3"},
  {name:"+WIS+", country:"挪威", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"308664", class:"3"},
  {name:"+WIS+", country:"美国", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"5936713", class:"3"},
  {name:"+WIS+", country:"巴西", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"918781434", class:"3"},
  {name:"+WIS+", country:"乌拉圭", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"510244", class:"3"},
  {name:"+WIS+", country:"巴拿马", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"278533-01", class:"3"},
  {name:"+WIS+", country:"哥斯达黎加", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"288232", class:"3"},
  {name:"+WIS+", country:"阿根廷", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"3855150", class:"3"},
  {name:"+WIS+", country:"智利", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"1323441", class:"3"},
  {name:"+WIS+", country:"墨西哥", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"2037911", class:"3"},
  {name:"+WIS+", country:"古巴", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"2020-0017", class:"3"},
  {name:"+WIS+", country:"加拿大", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"TMA1165076", class:"3"},
  // +WIS+ -- not successful
  {name:"+WIS+", country:"哥伦比亚", brand:"WIS", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"+WIS+", country:"秘鲁", brand:"WIS", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"+WIS+", country:"巴基斯坦", brand:"WIS", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"+WIS+", country:"泰国", brand:"WIS", entity:"", status:"被驳回后复审中", reg_no:"", class:"3"},
  {name:"+WIS+", country:"缅甸", brand:"WIS", entity:"", status:"修改法律后无效", reg_no:"", class:"3"},
  {name:"+WIS+", country:"伊朗", brand:"WIS", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"+WIS+", country:"叙利亚", brand:"WIS", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"+WIS+", country:"孟加拉国", brand:"WIS", entity:"", status:"下证中", reg_no:"", class:"3"},
  {name:"+WIS+", country:"伊拉克", brand:"WIS", entity:"", status:"下证中", reg_no:"", class:"3"},
  {name:"+WIS+", country:"斯里兰卡", brand:"WIS", entity:"", status:"初审中", reg_no:"", class:"3"},
  {name:"+WIS+", country:"新加坡", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"40201925747Y", class:"3"},
  {name:"+WIS+", country:"菲律宾", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"4/2019/021143", class:"3"},
  {name:"+WIS+", country:"柬埔寨", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"KH/81240/21", class:"3"},
  {name:"+WIS+", country:"老挝", brand:"WIS", entity:"", status:"已下证", reg_no:"", class:"3"},
  {name:"+WIS+", country:"蒙古", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"40-0021950", class:"3"},
  {name:"+WIS+", country:"马尔代夫", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"7040298", class:"3"},
  {name:"+WIS+", country:"马来西亚", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"TM2019044536", class:"3"},
  {name:"+WIS+", country:"尼泊尔", brand:"WIS", entity:"凡岛", status:"已下证", reg_no:"056301", class:"3"},
  {name:"+WIS+", country:"文莱", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"51187", class:"3"},
  {name:"+WIS+", country:"越南", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"410009", class:"3"},
  {name:"+WIS+", country:"不丹", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"BT/T2020/9549", class:"3"},
  {name:"+WIS+", country:"印度尼西亚", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"IDM001145466", class:"3"},
  {name:"+WIS+", country:"土耳其", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"2019/117278", class:"3"},
  {name:"+WIS+", country:"巴勒斯坦", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"38121", class:"3"},
  {name:"+WIS+", country:"科威特", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"KW1620295", class:"3"},
  {name:"+WIS+", country:"沙特阿拉伯", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"1441023312", class:"3"},
  {name:"+WIS+", country:"阿联酋", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"329189", class:"3"},
  {name:"+WIS+", country:"以色列", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"323095", class:"3"},
  {name:"+WIS+", country:"卡塔尔", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"138609", class:"3"},
  {name:"+WIS+", country:"印度", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"4196278", class:"3"},
  {name:"+WIS+", country:"摩洛哥", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"212312", class:"3"},
  {name:"+WIS+", country:"埃及", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"402990", class:"3"},
  {name:"+WIS+", country:"非洲（非洲知识产权组织）", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"118743", class:"3,21,35"},
  {name:"WIS", country:"南非", brand:"WIS", entity:"", status:"被驳回后复审中", reg_no:"", class:""},
  {name:"+WIS+", country:"中国香港", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"305123817", class:"3"},
  {name:"+WIS+", country:"中国澳门", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"N/162382(066)", class:"3"},
  {name:"+WIS+", country:"中国台湾", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"02071006", class:"3"},
  {name:"+WIS+", country:"日本", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"6332922", class:"3"},
  {name:"+WIS+", country:"朝鲜", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"158640", class:"3"},
  {name:"+WIS+", country:"韩国", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"40-1685889", class:"3"},
  {name:"+WIS+", country:"澳大利亚", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"2053696", class:"3"},
  {name:"+WIS+", country:"新西兰", brand:"WIS", entity:"慕可", status:"已下证", reg_no:"1135508", class:"3"},
  // KONO overseas
  {name:"KONO", country:"美国", brand:"KONO", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"KONO", country:"巴西", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"931404010", class:"3"},
  {name:"KONO", country:"瑞士", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"803765", class:"3"},
  {name:"KONO", country:"英国", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"018565136", class:"3"},
  {name:"KONO", country:"欧盟", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"018565136", class:"3"},
  {name:"KONO", country:"俄罗斯", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"978447", class:"3"},
  {name:"KONO", country:"挪威", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"325114", class:"3"},
  {name:"KONO", country:"乌拉圭", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"527034", class:"3"},
  {name:"KONO", country:"巴拿马", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"296117-01", class:"3"},
  {name:"KONO", country:"哥斯达黎加", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"2022-0000507", class:"3"},
  {name:"KONO", country:"阿根廷", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"3993936", class:"3"},
  {name:"KONO", country:"智利", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"1455581", class:"3"},
  {name:"KONO", country:"墨西哥", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"2596939", class:"3"},
  {name:"KONO", country:"加拿大", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"TMA1241367", class:"3"},
  {name:"KONO", country:"新加坡", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"40202318402S", class:"3"},
  {name:"KONO", country:"菲律宾", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"4/2023/00510752", class:"3"},
  {name:"KONO", country:"柬埔寨", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"KH/88125/22", class:"3"},
  {name:"KONO", country:"老挝", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"76175", class:"3"},
  {name:"KONO", country:"蒙古", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"40-0027826", class:"3"},
  {name:"KONO", country:"马来西亚", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"TM2023033485", class:"3"},
  {name:"KONO", country:"尼泊尔", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"088469", class:"3"},
  {name:"KONO", country:"文莱", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"61358", class:"3"},
  {name:"KONO", country:"越南", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"483488", class:"3"},
  {name:"KONO", country:"不丹", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"BT/T2023/47612", class:"3"},
  {name:"KONO", country:"印度尼西亚", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"IDM001259782", class:"3"},
  {name:"KONO", country:"土耳其", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"2023/116279", class:"3"},
  {name:"KONO", country:"巴勒斯坦", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"43184", class:"3"},
  {name:"KONO", country:"科威特", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"KW1942793", class:"3"},
  {name:"KONO", country:"沙特阿拉伯", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"1444036299", class:"3"},
  {name:"KONO", country:"阿联酋", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"509043", class:"3"},
  {name:"KONO", country:"以色列", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"363604", class:"3"},
  {name:"KONO", country:"卡塔尔", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"172702", class:"3"},
  {name:"KONO", country:"印度", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"6289269", class:"3"},
  {name:"KONO", country:"摩洛哥", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"254814", class:"3"},
  {name:"KONO", country:"埃及", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"470337", class:"3"},
  {name:"KONO", country:"非洲（非洲知识产权组织）", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"141085", class:"3"},
  {name:"KONO", country:"中国香港", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"306303108", class:"3"},
  {name:"KONO", country:"中国澳门", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"N/201047(132)", class:"3"},
  {name:"KONO", country:"中国台湾", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"02329238", class:"3"},
  {name:"KONO", country:"日本", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"6782384", class:"3"},
  {name:"KONO", country:"朝鲜", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"169302", class:"3"},
  {name:"KONO", country:"韩国", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"40-1791511", class:"3"},
  {name:"KONO", country:"韩国", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"40-2503800", class:"3"},
  {name:"KONO", country:"日本", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"6806347", class:"3"},
  {name:"KONO", country:"澳大利亚", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"2389272", class:"3"},
  {name:"KONO", country:"新西兰", brand:"KONO", entity:"慕可", status:"已下证", reg_no:"1266607", class:"3"},
  {name:"KONO", country:"哥伦比亚", brand:"KONO", entity:"", status:"初审中", reg_no:"", class:"3"},
  {name:"KONO", country:"秘鲁", brand:"KONO", entity:"", status:"初审中", reg_no:"", class:"3"},
  {name:"KONO", country:"巴基斯坦", brand:"KONO", entity:"", status:"被驳回后复审中", reg_no:"", class:"3"},
  {name:"KONO", country:"泰国", brand:"KONO", entity:"", status:"被驳回后复审中", reg_no:"", class:"3"},
  {name:"KONO", country:"缅甸", brand:"KONO", entity:"", status:"下证中", reg_no:"", class:"3"},
  {name:"KONO", country:"伊朗", brand:"KONO", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"KONO", country:"叙利亚", brand:"KONO", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"KONO", country:"孟加拉国", brand:"KONO", entity:"", status:"下证中", reg_no:"", class:"3"},
  {name:"KONO", country:"伊拉克", brand:"KONO", entity:"", status:"下证中", reg_no:"", class:"3"},
  {name:"KONO", country:"斯里兰卡", brand:"KONO", entity:"", status:"初审中", reg_no:"", class:"3"},
  {name:"KONO", country:"澳大利亚", brand:"KONO", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  {name:"KONO", country:"新西兰", brand:"KONO", entity:"", status:"被驳回后失效", reg_no:"", class:"3"},
  // HESY (赫系) overseas
  {name:"HESY", country:"美国", brand:"HESY", entity:"", status:"已提交申请", reg_no:"", class:""},
  {name:"HESY", country:"加拿大", brand:"HESY", entity:"", status:"已提交申请", reg_no:"", class:""},
  {name:"HESY", country:"巴西", brand:"HESY", entity:"", status:"已提交申请", reg_no:"", class:""},
  {name:"HESY", country:"墨西哥", brand:"HESY", entity:"", status:"已提交申请", reg_no:"", class:""},
  {name:"HESY", country:"韩国", brand:"HESY", entity:"", status:"已提交申请", reg_no:"", class:""},
  {name:"HESY", country:"日本", brand:"HESY", entity:"", status:"已提交申请", reg_no:"", class:""},
  {name:"HESY", country:"印度", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"越南", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"泰国", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"印度尼西亚", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"马来西亚", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"菲律宾", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"新加坡", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"缅甸", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"柬埔寨", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"文莱", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"老挝", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"土耳其", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"沙特阿拉伯", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"阿联酋", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"以色列", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"卡塔尔", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"中国澳门", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"中国香港", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"中国台湾", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"澳大利亚", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
  {name:"HESY", country:"新西兰", brand:"HESY", entity:"", status:"未提起申请", reg_no:"", class:""},
];

// ===== TABLE 6: 可续展商标 (tblAXcXVEVbkeuWM) =====
const renewableData = {
  note: "一年内到期需续展的商标",
  muke_renewable: ["19166917"],
  fandao_renewable: ["18811228","18825382","18825615","18826032","19125512"],
  all_renewable: ["18811228","18825382","18825615","18826032","19125512","19166917","19973952","20091859","20108704","20127159","20205706"],
  progress: "待提交申请"
};

// ===== TABLE 7: 商标注册申请 (tblfu8xhnlgNurOA) =====
const applicationsData = [
  {name:"K-KONO", brand:"KONO", entity:"广州慕可生物科技有限公司", region:"国内", status:"已通过", app_id:"202604280117"},
  {name:"奈然", brand:"WIS", entity:"广州慕可生物科技有限公司", region:"国内", status:"审批中", app_id:"202606020053"},
  {name:"赫系HESY", brand:"赫系", entity:"广州慕可生物科技有限公司", region:"海外", status:"已撤回", app_id:"202606120091"},
  {name:"赫系/赫系HESY", brand:"赫系", entity:"广州慕可生物科技有限公司", region:"海外", status:"已通过", app_id:"202606120092"},
  {name:"HESY", brand:"赫系", entity:"广州慕可生物科技有限公司", region:"国内", status:"审批中", app_id:"202606130063"},
];

// ===== Process all entities =====
const fandaoTrademarks = processRecords(allFandaoRaw);
const xinzhiyanTrademarks = processRecords(xinzhiyanRaw);
const chengziTrademarks = processRecords(chengziRaw);
const fandaoTzTrademarks = processRecords(fandaoTzRaw);

// Deduplicate 慕可 existing
const mukeSeen = new Set();
const mukeDeduped = [];
for (const t of existingMukeTrademarks) {
  const key = t.reg_no;
  if (!key || mukeSeen.has(key)) continue;
  mukeSeen.add(key);
  mukeDeduped.push(t);
}

// ===== Build output =====
const output = {
  _meta: {
    version: "2.0",
    last_updated: "2026-06-23",
    source: "飞书Bitable SkOFbs1M3aj6NWs2L49cffYQnVg",
    tables: [
      "tblmzJEFz98w0zUU (慕可)",
      "tblwlp57lZCiJTFQ (凡岛网络)",
      "tblVCT3lSFLEBqIJ (欣芝妍)",
      "tblG4S7AnyJAUTtk (橙子网络)",
      "tbluHJ5YZYxjx4u4 (凡岛投资)",
      "tblyFnnJVazQx0Uy (海外商标统计)",
      "tblAXcXVEVbkeuWM (可续展商标)",
      "tblfu8xhnlgNurOA (商标注册申请)"
    ]
  },
  entities: {
    "广州慕可生物科技有限公司": { trademarks: mukeDeduped },
    "广州凡岛网络科技有限公司": { trademarks: fandaoTrademarks },
    "广州欣芝妍化妆品有限公司": { trademarks: xinzhiyanTrademarks },
    "广州橙子网络科技有限公司": { trademarks: chengziTrademarks },
    "广州凡岛投资有限公司": { trademarks: fandaoTzTrademarks }
  },
  overseas_trademarks: overseasData,
  renewable_trademarks: renewableData,
  trademark_applications: applicationsData
};

// Write output
const outPath = path.join(__dirname, 'trademark-registry-full.json');
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
console.log('Written to', outPath);

// Summary
let grandTotal = 0;
for (const [entity, data] of Object.entries(output.entities)) {
  const count = data.trademarks.length;
  grandTotal += count;
  console.log(`  ${entity}: ${count} trademarks`);
}
console.log(`  Total domestic: ${grandTotal}`);
const overseasWithReg = overseasData.filter(r => r.reg_no).length;
console.log(`  Overseas records: ${overseasData.length} (${overseasWithReg} with reg no)`);
console.log(`  Trademark applications: ${applicationsData.length}`);
console.log(`\nFile size: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
