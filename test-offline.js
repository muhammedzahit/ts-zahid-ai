'use strict';
// Offline dogrulama: canli Webex/DB baglantisi olmadan modulleri ve mantigi test eder.
require('dotenv').config();

const { validateSelectQuery } = require('./lib/dbQuery');

const cases = [
  ['SELECT * FROM portal.users', true],
  ['select id, name from t', true],
  ['WITH x AS (SELECT 1) SELECT * FROM x', true],
  ['UPDATE t SET a=1', false],
  ['DELETE FROM t', false],
  ['SELECT 1; DROP TABLE t', false],
  ['drop table t', false],
  ['   ', false],
  ['SELECT * FROM t WHERE name = \'update me\'', true],
];

let pass = 0;
for (const [q, expected] of cases) {
  const r = validateSelectQuery(q);
  const ok = r.ok === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} | expected=${expected} got=${r.ok} | ${q}${r.reason ? ' -> ' + r.reason : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} gecti`);

// Mention ayiklama + parse testleri
const { stripBotMention, parseInput, htmlToText, parseMergeInterval } = require('./lib/parse');

const parseCases = [
  // [girdi, botAdi, beklenenKomut, beklenenRest]
  ['OSEM Bot islemler', 'OSEM Bot', 'islemler', ''],
  ['OSEM Bot 1\nabc@gmail.com', 'OSEM Bot', '1', 'abc@gmail.com'],
  ['OSEM Bot\n1\nabc@gmail.com', 'OSEM Bot', '1', 'abc@gmail.com'],
  ['OSEM Bot 2\nSELECT * FROM t', 'OSEM Bot', '2', 'SELECT * FROM t'],
  ['islemler', 'OSEM Bot', 'islemler', ''], // dogrudan mesaj (mention yok)
  ['2\nSELECT osem_bot FROM t', 'OSEM Bot', '2', 'SELECT osem_bot FROM t'], // SQL icine dokunma
  // Ayni satirda parametre (3. islemin dakika araligi icin gerekli)
  ['OSEM Bot 3 1', 'OSEM Bot', '3', '1'],
  ['3', 'OSEM Bot', '3', ''],
  ['3   10', 'OSEM Bot', '3', '10'],
  ['3\n5', 'OSEM Bot', '3', '5'], // alt satirda da yazilabilir
  ['6 staging', 'OSEM Bot', '6', 'staging'],
  // Ayni satir + alt satir birlikte: alt satir kazanir (cok satirli SQL bozulmasin)
  ['2 birinci\nSELECT * FROM t', 'OSEM Bot', '2', 'SELECT * FROM t'],
];

let parsePass = 0;
for (const [input, botName, expCmd, expRest] of parseCases) {
  const { command, rest } = parseInput(stripBotMention(input, botName));
  const ok = command === expCmd && rest === expRest;
  console.log(`${ok ? 'PASS' : 'FAIL'} | cmd="${command}" rest="${rest}" | girdi: ${JSON.stringify(input)}`);
  if (ok) parsePass++;
}
console.log(`\nParse: ${parsePass}/${parseCases.length} gecti`);

// 3. islem kontrol araligi testleri
const bos = parseMergeInterval('');
const bir = parseMergeInterval('1');
const on = parseMergeInterval('10');
const virgullu = parseMergeInterval('1,5');
const sifir = parseMergeInterval('0');
const cokBuyuk = parseMergeInterval('120');
const sacma = parseMergeInterval('abc');

const intervalCases = [
  ['bos parametre → varsayilan 3 dk', bos.dakika === 3 && bos.verildi === false && bos.uyari === null],
  ['"1" → 1 dk, verildi', bir.dakika === 1 && bir.verildi === true],
  ['"10" → 10 dk', on.dakika === 10 && on.verildi === true],
  ['virgullu ondalik okunuyor', virgullu.dakika === 1.5 && virgullu.verildi === true],
  ['0 reddedilir, varsayilana doner', sifir.dakika === 3 && sifir.verildi === false && !!sifir.uyari],
  ['120 (sinir ustu) reddedilir', cokBuyuk.dakika === 3 && !!cokBuyuk.uyari],
  ['sayi olmayan reddedilir', sacma.dakika === 3 && sacma.verildi === false && !!sacma.uyari],
];

let intervalPass = 0;
for (const [desc, ok] of intervalCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) intervalPass++;
}
console.log(`\nMerge kontrol araligi: ${intervalPass}/${intervalCases.length} gecti`);

// HTML (mention'li mesaj) testleri — shift+enter <br/> veya <p> olarak gelir.
const MENTION = '<spark-mention data-object-type="person" data-object-id="abc-123">OSEM Bot</spark-mention>';
const htmlCases = [
  // [html, beklenenKomut, beklenenRest]
  [`<p>${MENTION} islemler</p>`, 'islemler', ''],
  [`<p>${MENTION} 1<br/>abc@gmail.com</p>`, '1', 'abc@gmail.com'],
  [`<p>${MENTION} 1</p><p>abc@gmail.com</p>`, '1', 'abc@gmail.com'],
  [`<p>${MENTION}</p><p>2</p><p>SELECT * FROM t</p>`, '2', 'SELECT * FROM t'],
  [`<p>${MENTION} 2<br/>SELECT * FROM t WHERE a &lt; 5 AND b = &#39;x&#39;</p>`, '2', "SELECT * FROM t WHERE a < 5 AND b = 'x'"],
  [`<p>${MENTION} 2<br/>SELECT a &amp;&amp; b FROM t</p>`, '2', 'SELECT a && b FROM t'],
];

let htmlPass = 0;
for (const [html, expCmd, expRest] of htmlCases) {
  const text = stripBotMention(htmlToText(html, 'OSEM Bot'), 'OSEM Bot');
  const { command, rest } = parseInput(text);
  const ok = command === expCmd && rest === expRest;
  console.log(`${ok ? 'PASS' : 'FAIL'} | cmd="${command}" rest="${rest}" | html: ${html.slice(0, 80)}...`);
  if (ok) htmlPass++;
}
console.log(`\nHTML: ${htmlPass}/${htmlCases.length} gecti`);

// Grup bazli yetkilendirme testleri (sahte env ile, canli baglanti yok)
const { loadRoomPermissions, isAllowed } = require('./lib/permissions');

const fakeEnv = {
  WEBEX_ROOM_ID: 'room-eski', // soneksiz — grup sayilmamali
  WEBEX_ROOM_ID_GRUP1: 'room-1',
  WEBEX_ROOM_ID_GRUP1_YETKILER: 'all',
  WEBEX_ROOM_ID_GRUP2: 'room-2',
  WEBEX_ROOM_ID_GRUP2_YETKILER: '3',
  WEBEX_ROOM_ID_GRUP3: 'room-3', // _YETKILER yok → hicbir islem yetkili degil
  ALAKASIZ_DEGISKEN: 'x',
};
const perms = loadRoomPermissions(fakeEnv);

const permCases = [
  // [aciklama, kosul]
  ['duz WEBEX_ROOM_ID grup sayilmaz', !perms.has('room-eski')],
  ['3 grup yuklendi', perms.size === 3],
  ['GRUP1 (all) → 1 izinli', isAllowed(perms.get('room-1'), '1')],
  ['GRUP1 (all) → 3 izinli', isAllowed(perms.get('room-1'), '3')],
  ['GRUP1 (all) → 4 izinli', isAllowed(perms.get('room-1'), '4')],
  ['GRUP2 (3) → 4 yasak', !isAllowed(perms.get('room-2'), '4')],
  ['GRUP2 (3) → 3 izinli', isAllowed(perms.get('room-2'), '3')],
  ['GRUP2 (3) → 1 yasak', !isAllowed(perms.get('room-2'), '1')],
  ['GRUP3 (_YETKILER yok) → 1 yasak', !isAllowed(perms.get('room-3'), '1')],
  ['tanimsiz oda → yasak', !isAllowed(perms.get('room-yok'), '3')],
];

let permPass = 0;
for (const [desc, ok] of permCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) permPass++;
}
console.log(`\nYetki: ${permPass}/${permCases.length} gecti`);

// Makine bazli dinleme (DINLENEN_ISLEMLER) testleri
const { loadListenedOps } = require('./lib/permissions');

const dinleCases = [
  ['tanimsiz → hepsi dinlenir', isAllowed(loadListenedOps({}), '6')],
  ['bos → hepsi dinlenir', isAllowed(loadListenedOps({ DINLENEN_ISLEMLER: '  ' }), '1')],
  ['all → hepsi dinlenir', isAllowed(loadListenedOps({ DINLENEN_ISLEMLER: 'ALL' }), '4')],
  ['"1,2,3" → 2 dinlenir', isAllowed(loadListenedOps({ DINLENEN_ISLEMLER: '1,2,3' }), '2')],
  ['"1,2,3" → 4 dinlenmez', !isAllowed(loadListenedOps({ DINLENEN_ISLEMLER: '1,2,3' }), '4')],
  ['bosluklu liste → 6 dinlenir', isAllowed(loadListenedOps({ DINLENEN_ISLEMLER: ' 4 , 6 ' }), '6')],
  ['DINLENEN_ISLEMLER grup sayilmaz', loadRoomPermissions({ DINLENEN_ISLEMLER: '1' }).size === 0],
];

let dinlePass = 0;
for (const [desc, ok] of dinleCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) dinlePass++;
}
console.log(`\nDinlenen islemler: ${dinlePass}/${dinleCases.length} gecti`);

// Merge notlari (4. islem) testleri — gercek not dosyasina dokunmamak icin
// gecici bir dosya kullanilir; modul MERGE_NOTES_FILE'i require aninda okur.
const os = require('os');
const fsTest = require('fs');
const pathTest = require('path');

const tmpNotesFile = pathTest.join(os.tmpdir(), `osem-bot-notes-test-${process.pid}.json`);
try { fsTest.unlinkSync(tmpNotesFile); } catch (e) { /* dosya yoktu */ }
process.env.MERGE_NOTES_FILE = tmpNotesFile;

const mergeNotes = require('./lib/mergeNotes');

const bosBaslangic = mergeNotes.listNotes();
const not1 = mergeNotes.addNote({ author: 'Ahmet Yilmaz', text: 'Cache temizlensin' });
const not2 = mergeNotes.addNote({ author: 'Mehmet Demir', text: 'Config guncellemesi var' });
const iki = mergeNotes.listNotes();
const metin = mergeNotes.formatNotes(iki);
const diskten = JSON.parse(fsTest.readFileSync(tmpNotesFile, 'utf8'));
const silinen = mergeNotes.clearNotes();
const sonrasi = mergeNotes.listNotes();
const bosMetinSonrasiEkle = mergeNotes.addNote({ author: 'Ayse Kaya', text: 'Yeni not' });

const noteCases = [
  ['dosya yokken liste bos', bosBaslangic.length === 0],
  ['iki not eklendi, sira korunuyor', iki.length === 2 && iki[0].text === 'Cache temizlensin' && iki[1].author === 'Mehmet Demir'],
  ['id\'ler artiyor', not1.id === 1 && not2.id === 2],
  ['formatNotes ad + not iceriyor', metin.includes('Ahmet Yilmaz') && metin.includes('Config guncellemesi var') && metin.includes('(2)')],
  ['notlar diske yazildi', diskten.notes.length === 2],
  ['clearNotes silinen adedi doner', silinen === 2],
  ['temizleme sonrasi liste bos', sonrasi.length === 0],
  ['temizleme sonrasi id tekrar etmiyor', bosMetinSonrasiEkle.id === 3],
];

let notePass = 0;
for (const [desc, ok] of noteCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) notePass++;
}
console.log(`\nMerge notlari: ${notePass}/${noteCases.length} gecti`);
try { fsTest.unlinkSync(tmpNotesFile); } catch (e) { /* temizlik */ }

// Liquibase (6. islem) cikti ayristirma testleri — canli calistirma yok,
// yalnizca run.cmd ciktisinin dogru okundugu dogrulanir.
const { ciktiyiAyristir, uygulananSayisi } = require('./lib/liquibaseRun');

const onizlemeCikti = [
  '17:24:07 INFO  Starting LiquibaseRunnerApp using Java 21.0.8',
  'PROFIL: staging',
  'MOD: PREVIEW',
  'URL: jdbc:postgresql://172.18.247.139:7432/osem_test?currentSchema=portal',
  'SEMA: portal',
  'CHANGELOG: classpath:db/changelog/changelog-master.xml',
  'DROP_FIRST: false',
  'BEKLEYEN_ADET: 2',
  'BEKLEYEN: db/changelog/v1.2.0/APTY-118762.xml :: APTY-118762-1 :: osem',
  'BEKLEYEN: db/changelog/v1.2.0/APTY-121861.xml :: APTY-121861-1 :: osem',
  'SQL_DOSYASI: C:\\proje\\target\\preview\\onizleme-prod-2026-08-18_17-24-07.sql',
  'SONUC: BASARILI',
].join('\r\n');

const hataCikti = ['MOD: UPDATE', 'SONUC: HATA', 'HATA_MESAJI: ValidationFailedException: Validation Failed:'].join('\n');

const updateCikti = [
  'MOD: UPDATE',
  '17:30:01 INFO  ChangeSet db/changelog/a.xml::a1::osem ran successfully in 12ms',
  '17:30:01 INFO  ChangeSet db/changelog/b.xml::b1::osem ran successfully in 3ms',
  'UYGULANAN_ADET: 3',
  'UYGULANAN: db/changelog/a.xml :: a1 :: osem :: EXECUTED',
  'UYGULANAN: db/changelog/b.xml :: b1 :: osem :: EXECUTED',
  'UYGULANAN: db/changelog/c.xml :: c1 :: osem :: MARK_RAN',
  'SONUC: BASARILI',
].join('\n');

// Ortada patlayan update: patlamadan once uygulananlar raporlanmali.
const yarimUpdateCikti = [
  'MOD: UPDATE',
  'UYGULANAN_ADET: 2',
  'UYGULANAN: db/changelog/a.xml :: a1 :: osem :: EXECUTED',
  'UYGULANAN: db/changelog/b.xml :: b1 :: osem :: EXECUTED',
  'BASARISIZ_CHANGESET: db/changelog/c.xml :: c1 :: osem',
  'SONUC: HATA',
  'HATA_MESAJI: PSQLException: ERROR: syntax error at or near "BU"',
].join('\n');

const o = ciktiyiAyristir(onizlemeCikti);
const h = ciktiyiAyristir(hataCikti);
const u = ciktiyiAyristir(updateCikti);
const y = ciktiyiAyristir(yarimUpdateCikti);

const liquibaseCases = [
  ['onizleme basarili okundu', o.basarili === true],
  ['profil/mod okundu', o.profil === 'staging' && o.mod === 'PREVIEW'],
  ['dropFirst false okundu', o.dropFirst === 'false'],
  ['bekleyen adet sayi olarak okundu', o.bekleyenAdet === 2],
  ['BEKLEYEN_ADET, BEKLEYEN ile karistirilmadi', o.bekleyenler.length === 2],
  ['bekleyen satiri dogru ayiklandi', o.bekleyenler[0] === 'db/changelog/v1.2.0/APTY-118762.xml :: APTY-118762-1 :: osem'],
  ['sql dosyasi okundu', o.sqlDosyasi.endsWith('.sql')],
  ['hata ciktisi basarisiz sayildi', h.basarili === false],
  ['hata mesaji okundu', h.hataMesaji.includes('Validation Failed')],
  ['uygulanan adet dinleyiciden okundu', u.uygulananAdet === 3],
  ['UYGULANAN_ADET, UYGULANAN ile karistirilmadi', u.uygulananlar.length === 3],
  ['uygulanan satiri exec tipiyle okundu', u.uygulananlar[2] === 'db/changelog/c.xml :: c1 :: osem :: MARK_RAN'],
  ['basarili update icin basarisiz changeset yok', u.basarisizChangeSet === null],
  ['yarim update: uygulananlar okundu', y.uygulananAdet === 2 && y.uygulananlar.length === 2],
  ['yarim update: patlayan changeset okundu', y.basarisizChangeSet === 'db/changelog/c.xml :: c1 :: osem'],
  ['yarim update basarisiz sayildi', y.basarili === false],
  ['onizlemede uygulanan listesi bos', o.uygulananlar.length === 0 && o.uygulananAdet === null],
  ['yedek log sayaci calisiyor', uygulananSayisi(updateCikti) === 2],
];

let liquibasePass = 0;
for (const [desc, ok] of liquibaseCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) liquibasePass++;
}
console.log(`\nLiquibase cikti ayristirma: ${liquibasePass}/${liquibaseCases.length} gecti`);

// tempPassword modulu yuklenebiliyor mu?
require('./lib/tempPassword');
console.log('lib/tempPassword.js yuklendi.');
console.log('Env kontrol: PROD_LOGIN_URI =', process.env.PROD_LOGIN_URI ? 'OK' : 'EKSIK');
console.log('Env kontrol: SHARED_FOLDER =', process.env.SHARED_FOLDER ? 'OK' : 'EKSIK');
