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
const tumuCases = [
  ['tumu: ayni satir', parseInput('5-2 a.md b.docx').tumu === 'a.md b.docx'],
  ['tumu: ayni satir + alt satir birlikte', parseInput('5-2 a.md\nb.docx').tumu === 'a.md\nb.docx' && parseInput('5-2 a.md\nb.docx').rest === 'b.docx'],
  ['tumu: yalnizca alt satir', parseInput('5\nAPTY-1').tumu === 'APTY-1'],
  ['tumu: parametre yok', parseInput('3').tumu === ''],
];
for (const [desc, ok] of tumuCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) parsePass++;
}
console.log(`\nParse: ${parsePass}/${parseCases.length + tumuCases.length} gecti`);

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

// --- 5. islem: kod incelemesi (saf fonksiyonlar, git/LLM cagrisi yok) -------
const kr = require('./lib/kodReview');

const uzunMetin = ['**Ozet**', 'x'.repeat(50), '```java', ...Array.from({ length: 400 }, (_, i) => `satir ${i} şğüöçı`), '```', 'son'].join('\n');
const krParcalar = kr.parcala(uzunMetin, 2000);
const tekUzunSatir = kr.parcala('ş'.repeat(5000), 2000);

const krCases = [
  ['branch + talep anahtari', kr.branchCoz('APTY-123').aranan === 'APTY-123'],
  ['feature/ onekli branch', kr.branchCoz('feature/apty-77 full').branch === 'feature/apty-77' && kr.branchCoz('feature/apty-77').aranan === 'APTY-77'],
  ['anahtarsiz branch adi aranir', kr.branchCoz('hotfix-login').aranan === 'hotfix-login'],
  ['bos girdi', kr.branchCoz('  ').hata === 'bos'],
  ['- ile baslayan reddedilir', !!kr.branchCoz('--upload-pack=x').hata],
  ['.. iceren reddedilir', !!kr.branchCoz('a..b').hata],
  ['ozel karakter reddedilir', !!kr.branchCoz('a;rm').hata],
  ['log ayristirma', (() => { const c = kr.logAyristir('abc\x1fab\x1fAli\x1f2026-10-01\x1fAPTY-1 update\n'); return c.length === 1 && c[0].mesaj === 'APTY-1 update' && c[0].yazar === 'Ali'; })()],
  ['think blogu temizlenir', kr.dusunceyiTemizle('<think>a\nb</think>\nCevap') === 'Cevap'],
  ['parcalar bayt sinirinda', krParcalar.every((p) => Buffer.byteLength(p) <= 2000)],
  ['birden fazla parca', krParcalar.length > 1],
  ['kod blogu her parcada dengeli', krParcalar.every((p) => (p.match(/^```/gm) || []).length % 2 === 0)],
  ['icerik kaybolmaz', krParcalar.join('\n').includes('satir 399 şğüöçı') && krParcalar.join('\n').includes('son')],
  ['tek uzun satir bolunur', tekUzunSatir.length > 1 && tekUzunSatir.every((p) => Buffer.byteLength(p) <= 2000)],
  ['kisa metin tek parca', kr.parcala('merhaba').length === 1],
  ['varsayilan model strata', kr.llmAyarlari({}).model === 'strata'],
  ['varsayilan reasoning high', kr.llmAyarlari({}).reasoning === 'high'],
  ['reasoning - ise gonderilmez', kr.llmAyarlari({ LLM_REASONING_EFFORT: '-' }).reasoning === ''],
  ['varsayilan timeout 30 dk', kr.llmAyarlari({}).timeoutMs === 1800000],
  ['sinir bos → varsayilan', kr.sinirOku(undefined, 30) === 30 && kr.sinirOku('', 30) === 30],
  ['sinir sayi okunur', kr.sinirOku('50', 30) === 50],
  ['2147483647 → sinirsiz', kr.sinirOku('2147483647', 30) === Infinity],
  ['0 → sinirsiz', kr.sinirOku('0', 30) === Infinity],
  ['"sinirsiz" → sinirsiz', kr.sinirOku('Sinirsiz', 30) === Infinity],
  ['gecersiz → varsayilan', kr.sinirOku('abc', 30) === 30],
  ['baglanti hatasi Turkce', kr.hataMesaji({ code: 'ECONNREFUSED', message: '' }).includes('ulasilamadi')],
  ['menude yerel AI uyarisi var', kr.YEREL_AI_UYARISI.includes('gonderilmez')],
  ['puan okunur ve govdeden ayrilir', (() => { const r = kr.puanAyristir('PUAN: 78/100\n\n**Ozet**\nx'); return r.puan === 78 && r.govde.startsWith('**Ozet**'); })()],
  ['kalin yazilmis puan okunur', kr.puanAyristir('**PUAN:** 85/100\n**Ozet**').puan === 85],
  ['puan bosluklu yazilsa da okunur', kr.puanAyristir('puan : 40 / 100\nmetin').puan === 40],
  ['puan yoksa null', kr.puanAyristir('**Ozet**\nx').puan === null],
  ['100 ustu puan 100e cekilir', kr.puanAyristir('PUAN: 150/100').puan === 100],
  ['puan etiketi renkli', kr.puanEtiketi(90).startsWith('🟢') && kr.puanEtiketi(70).startsWith('🟡') && kr.puanEtiketi(30).startsWith('🔴')],
  ['puan yoksa etiket', kr.puanEtiketi(null).includes('verilmedi')],
  ['ozet bolumu cikarilir', kr.ozetCikar('**Ozet**\nBolme eklendi.\n\n**Bulgular**\n🟠 a') === 'Bolme eklendi.'],
  ['ozet basligi yoksa bastan alinir', kr.ozetCikar('duz metin') === 'duz metin'],
  ['bulgular sayilir', (() => { const b = kr.bulguSay('🔴 a\n🟠 b\n🟠 c\n🟡 d'); return b.kritik === 1 && b.onemli === 2 && b.kucuk === 1; })()],
  ['raporda puan ve commit var', (() => { const r = kr.raporOlustur({ branch: 'APTY-1', ref: 'origin/APTY-1', commitler: [{ kisa: 'abc', tarih: 't', yazar: 'Ali', mesaj: 'APTY-1 update' }], govde: 'G', puan: 64, model: 'strata', sureSn: 5 }); return r.includes('**Puan:** 64/100') && r.includes('APTY-1 update') && r.includes('## Inceleme\n\nG'); })()],
];

let krPass = 0;
for (const [desc, ok] of krCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) krPass++;
}
console.log(`\nKod incelemesi: ${krPass}/${krCases.length} gecti`);

// --- 5. islem: STAGING salt-okuma + ajan dongusu (DB/ag yok) --------------
const so = require('./lib/stagingOku');
const ajan = require('./lib/llmAjan');
const tmpEnv = pathTest.join(os.tmpdir(), `staging-env-test-${process.pid}`);
fsTest.writeFileSync(tmpEnv, '# yorum\r\nSTAGING_DB_URL=jdbc:postgresql://db.local:6543/osem_test?currentSchema=portal\r\nSTAGING_DB_USERNAME=okur\r\nSTAGING_DB_PASSWORD=p=1!\r\nPROD_DB_URL=jdbc:postgresql://prod:1/prod\r\nPROD_DB_PASSWORD=gizli\r\n');
const stEnv = so.stagingEnvOku(tmpEnv);
const stAyar = so.stagingAyarlari({}, tmpEnv);
const araclarStagingli = kr.araclariOlustur({ ref: 'origin/X-1', commitler: [], staging: stAyar }).map((a) => a.tanim.function.name);
const araclarStagingsiz = kr.araclariOlustur({ ref: 'origin/X-1', commitler: [], staging: null }).map((a) => a.tanim.function.name);

const ajanCases = [
  ['jdbc url cozulur', (() => { const j = so.jdbcCoz('jdbc:postgresql://h:5433/db1?currentSchema=portal'); return j.host === 'h' && j.port === 5433 && j.database === 'db1' && j.schema === 'portal'; })()],
  ['jdbc port yoksa 5432', so.jdbcCoz('jdbc:postgresql://h/db').port === 5432],
  ['gecersiz jdbc → null', so.jdbcCoz('postgres://h/db') === null],
  ['.env yalnizca STAGING anahtarlari', Object.keys(stEnv).every((k) => k.startsWith('STAGING_DB_')) && !('PROD_DB_PASSWORD' in stEnv)],
  ['sifredeki = korunur', stEnv.STAGING_DB_PASSWORD === 'p=1!'],
  ['staging ayari kurulur', stAyar && stAyar.host === 'db.local' && stAyar.user === 'okur' && stAyar.schema === 'portal'],
  ['KOD_REVIEW_STAGING=kapali → null', so.stagingAyarlari({ KOD_REVIEW_STAGING: 'kapali' }, tmpEnv) === null],
  ['.env yoksa → null', so.stagingAyarlari({}, tmpEnv + '-yok') === null],
  ['SELECT gecer', so.sorguDogrula('select * from users').ok],
  ['nextval reddedilir', !so.sorguDogrula("select nextval('s')").ok],
  ['dblink reddedilir', !so.sorguDogrula("select * from dblink('a','b') t(x int)").ok],
  ['set_config reddedilir', !so.sorguDogrula("select set_config('a','b',true)").ok],
  ['FOR SHARE reddedilir', !so.sorguDogrula('select * from users for share').ok],
  ['DELETE reddedilir', !so.sorguDogrula('delete from users').ok],
  ['string icindeki nextval yanlis alarm vermez', so.sorguDogrula("select * from log where msg = 'nextval cagrildi'").ok],
  ['ayni adli kolonlar ezilmez', so.sonucuBicimle({ fields: [{ name: 'a' }, { name: 'a' }], rows: [[1, 2]] }).includes('1 | 2')],
  ['50 satir siniri bildirilir', so.sonucuBicimle({ fields: [{ name: 'n' }], rows: Array.from({ length: 51 }, (_, i) => [i]) }).includes('ilk 50 satir')],
  ['NULL ve uzun hucre', (() => { const s = so.sonucuBicimle({ fields: [{ name: 'a' }, { name: 'b' }], rows: [[null, 'x'.repeat(900)]] }); return s.includes('NULL') && s.includes('…'); })()],
  ['staging varken arac listede', araclarStagingli.includes('staging_sorgu') && araclarStagingli.length === 5],
  ['staging yokken arac listede degil', !araclarStagingsiz.includes('staging_sorgu') && araclarStagingsiz.length === 4],
  ['sistem mesajinda salt-okuma kurali', kr.sistemMesaji({ araclarVar: true, stagingVar: true }).includes('YALNIZCA OKUNABILIR')],
  ['aracsiz sistem mesajinda arac yok', !kr.sistemMesaji().includes('staging_sorgu')],
  ['buyuk diff karari', kr.buyukDiffMi('x'.repeat(400000), 262144) && !kr.buyukDiffMi('x'.repeat(300000), 262144)],
  ['varsayilan adim 40, pencere 262144', kr.llmAyarlari({}).maxAdim === 40 && kr.llmAyarlari({}).baglamPenceresi === 262144],
  ['KOD_REVIEW_ARACLAR=kapali', kr.llmAyarlari({ KOD_REVIEW_ARACLAR: 'kapali' }).araclarKapali === true],
  ['arac ozeti satiri', kr.aracOzeti({ adim: 4, sikistirma: 1, stagingVar: true, aracKayitlari: [{ ad: 'dosya_oku' }, { ad: 'staging_sorgu' }] }).includes('1 staging sorgusu · 1 sikistirma')],
  ['aracsiz ozet', kr.aracOzeti({ aracsiz: true }).includes('kullanilmadi')],
  ['arac sonucu kirpilir', ajan.aracSonucunuKirp('x'.repeat(ajan.ARAC_SONUC_MAKS + 10)).includes('ilk 60000 karakter')],
  ['token tahmini', ajan.tokenTahmini(300) === 100],
  ['400 → arac desteklenmiyor', ajan.aracDesteklenmiyorMu({ response: { status: 400 } }) && !ajan.aracDesteklenmiyorMu({ code: 'ECONNREFUSED' })],
];
fsTest.unlinkSync(tmpEnv);

let ajanPass = 0;
for (const [desc, ok] of ajanCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) ajanPass++;
}
console.log(`\nStaging + ajan: ${ajanPass}/${ajanCases.length} gecti`);

// --- 5. islem: kuyruk + onay (gecici klasor) -------------------------------
const kq = require('./lib/kodReviewKuyruk');
const kqDir = fsTest.mkdtempSync(pathTest.join(os.tmpdir(), 'kod-review-kuyruk-'));
const kqT0 = 1_700_000_000_000;
const kq1 = kq.ekle({ branch: 'APTY-1', aranan: 'APTY-1', roomId: 'r', kim: 'Ali', kimEmail: 'ali@x.com' }, kqDir, kqT0);
const kq2 = kq.ekle({ branch: 'APTY-2', aranan: 'APTY-2', roomId: 'r', kim: 'Veli', kimEmail: 'veli@x.com' }, kqDir, kqT0 + 1000);
const kqSahip1 = kq.sahiplen('mesaj-1', kqDir);
const kqSahip2 = kq.sahiplen('mesaj-1', kqDir);
const kqIsaret = kq.isleniyorIsaretle(kq1, kqDir);
const kqBekleyenIslemde = kq.bekleyenler(kqDir).map((t) => t.branch).join(',');
const kqGeri = kq.geriAl(kq1, kqDir);
kq.isleniyorIsaretle(kq1, kqDir);
const kqKurtarilan = kq.kurtar(kqDir);
const kqDolan = kq.sureDolanlariAyikla(kqDir, 24 * 3600 * 1000, kqT0 + 24 * 3600 * 1000 + 500);
const kqKalan = kq.bekleyenler(kqDir).map((t) => t.branch).join(',');

const kuyrukCases = [
  ['iki talep sirali', kq.bekleyenler(kqDir).length >= 1 && kq1.dosya < kq2.dosya],
  ['talep id 6 hex', /^[0-9a-f]{6}$/.test(kq1.id)],
  ['ilk sahiplenme true', kqSahip1 === true],
  ['ikinci sahiplenme false (diger makine sessiz)', kqSahip2 === false],
  ['sahiplenildiMi', kq.sahiplenildiMi('mesaj-1', kqDir) && !kq.sahiplenildiMi('mesaj-2', kqDir)],
  ['isleniyor bekleyenlerde gorunmez', kqIsaret && kqBekleyenIslemde === 'APTY-2'],
  ['geri alinir', kqGeri === true],
  ['kurtar isleniyoru geri alir', kqKurtarilan === 1],
  ['24 saat dolan ayiklanir', kqDolan.length === 1 && kqDolan[0].branch === 'APTY-1' && kqKalan === 'APTY-2'],
  ['id ile bulunur', kq.bul(`#${kq2.id}`, kqDir).branch === 'APTY-2'],
  ['branch ile bulunur (harf duyarsiz)', kq.bul('apty-2', kqDir).id === kq2.id],
  ['sil', kq.sil(kq2, kqDir) && kq.bekleyenler(kqDir).length === 0],
  ['bos klasor → bos liste', kq.bekleyenler(pathTest.join(kqDir, 'yok')).length === 0],
  ['onaylayici e-posta (harf duyarsiz)', kq.onaylayiciMi({ email: 'Zahid@X.com' }, { KOD_REVIEW_ONAYLAYANLAR: 'zahid@x.com, b@x.com' })],
  ['onaylayici ad (Turkce, bosluk)', kq.onaylayiciMi({ ad: 'zahid  aydın' }, { KOD_REVIEW_ONAYLAYANLAR: 'Zahid Aydın' })],
  ['onaylayici degil', !kq.onaylayiciMi({ email: 'ali@x.com', ad: 'Ali' }, { KOD_REVIEW_ONAYLAYANLAR: 'zahid@x.com' })],
  ['liste bossa kimse onaylayamaz', !kq.onaylayiciMi({ email: 'a@x.com', ad: 'A' }, {})],
  ['bos e-posta ad eslesmesine dusmez', !kq.onaylayiciMi({ email: '', ad: '' }, { KOD_REVIEW_ONAYLAYANLAR: 'zahid@x.com' })],
  ['alt komut onay', kq.altKomutCoz('Onay').tur === 'onay' && kq.altKomutCoz('onayla').tur === 'onay'],
  ['alt komut liste', kq.altKomutCoz('liste').tur === 'liste' && kq.altKomutCoz('kuyruk').tur === 'liste'],
  ['alt komut iptal', (() => { const a = kq.altKomutCoz('iptal #ab12cd'); return a.tur === 'iptal' && a.hedef === '#ab12cd'; })()],
  ['alt komut ekle', (() => { const a = kq.altKomutCoz('APTY-5'); return a.tur === 'ekle' && a.girdi === 'APTY-5'; })()],
  ['alt komut bos', kq.altKomutCoz('  ').tur === 'bos'],
  ['alt komut itiraz', (() => { const a = kq.altKomutCoz('itiraz r.md\nreddiye.docx'); return a.tur === 'itiraz' && a.girdi === 'r.md\nreddiye.docx' && kq.altKomutCoz('Reddiye a b').tur === 'itiraz'; })()],
  ['varsayilan bekleme 24 sa', kq.bekleme({}) === 24 * 3600 * 1000 && kq.bekleme({ KOD_REVIEW_KUYRUK_SURE_SAAT: '48' }) === 48 * 3600 * 1000],
  ['sure yazimi', kq.sureYaz(7_380_000) === '2 sa 3 dk' && kq.sureYaz(300_000) === '5 dk' && kq.sureYaz(7_200_000) === '2 sa'],
  ['baglanti hatasi tanima', ajan.baglantiHatasiMi({ code: 'ECONNREFUSED' }) && ajan.baglantiHatasiMi({ message: 'socket hang up' }) && ajan.baglantiHatasiMi({ response: { status: 503 } }) && !ajan.baglantiHatasiMi({ response: { status: 400 }, message: 'x' })],
  ['llm tanimli mi', kr.llmTanimliMi({ LLM_BASE_URL: 'http://x/v1' }) && !kr.llmTanimliMi({})],
];
fsTest.rmSync(kqDir, { recursive: true, force: true });

let kuyrukPass = 0;
for (const [desc, ok] of kuyrukCases) {
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
  if (ok) kuyrukPass++;
}
console.log(`\nKod incelemesi kuyrugu: ${kuyrukPass}/${kuyrukCases.length} gecti`);

// --- 5-2: incelemeye itiraz (reddiye) — gecici ortak alan, git/LLM cagrisi yok ---
const it = require('./lib/kodReviewItiraz');
(async () => {
  const JSZip = require('jszip');
  const ortak = fsTest.mkdtempSync(pathTest.join(os.tmpdir(), 'itiraz-ortak-'));
  const disari = pathTest.join(os.tmpdir(), `itiraz-disari-${process.pid}.md`);
  const commit = { sha: 'abc1234def', kisa: 'abc1234', tarih: '2026-11-01', yazar: 'Ali', mesaj: 'APTY-9 update' };
  const rapor = kr.raporOlustur({ branch: 'feature/APTY-9', ref: 'origin/feature/APTY-9', commitler: [commit], govde: '**Ozet**\nx\n\n**Bulgular**\n🔴 `abc` sorunu', puan: 42, model: 'strata', sureSn: 3 });
  const belgeXml =
    '<w:document><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Balk1"/></w:pPr><w:r><w:t>Reddiye</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">1. bulgu yanlis: </w:t></w:r><w:r><w:t>a &lt; b &amp;&amp; c kontrolu var</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>madde</w:t><w:tab/><w:t>iki</w:t><w:br/><w:t>alt satir</w:t></w:r></w:p>' +
    '<w:p><w:del><w:r><w:delText>silinmis</w:delText></w:r></w:del><w:r><w:t>kalan şğı</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Ekran goruntusu:</w:t></w:r><w:r><mc:AlternateContent><mc:Choice><w:drawing><a:blip r:embed="rId7" cstate="print"/></w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict><v:imagedata r:id="rId7"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
    '<w:p><w:r><w:pict><v:imagedata r:id="rId8" o:title=""/></w:pict></w:r></w:p>' +
    '<w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r><w:r><w:t>son</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId7"/></w:drawing></w:r></w:p>' +
    '</w:body></w:document>';
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
  const zip = new JSZip();
  zip.file('word/document.xml', belgeXml);
  zip.file('word/_rels/document.xml.rels',
    '<Relationships><Relationship Id="rId7" Type="x/image" Target="media/image1.png"/>' +
    '<Relationship Id="rId8" Type="x/image" Target="media/image2.emf"/>' +
    '<Relationship Id="rId9" Type="x/image" Target="/word/media/foto.jpeg"/>' +
    '<Relationship Id="rId1" Type="x/hyperlink" Target="http://x" TargetMode="External"/></Relationships>');
  zip.file('word/media/image1.png', png);
  zip.file('word/media/image2.emf', Buffer.alloc(64, 3));
  zip.file('word/media/foto.jpeg', jpg);
  zip.file('word/media/kullanilmayan.png', png);
  fsTest.writeFileSync(pathTest.join(ortak, 'kod_review_APTY-9.md'), rapor);
  fsTest.writeFileSync(pathTest.join(ortak, 'reddiye.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  fsTest.writeFileSync(pathTest.join(ortak, 'reddiye son.txt'), '\uFEFFKatilmiyorum.\r\n');
  fsTest.writeFileSync(pathTest.join(ortak, 'bos.md'), '  ');
  fsTest.writeFileSync(pathTest.join(ortak, 'bozuk.docx'), 'zip degil');
  fsTest.mkdirSync(pathTest.join(ortak, 'alt'));
  fsTest.writeFileSync(pathTest.join(ortak, 'alt', 'not.md'), 'alt klasor');
  fsTest.writeFileSync(disari, 'gizli');

  const hz = await it.hazirla({ review: 'kod_review_APTY-9.md', reddiye: 'reddiye.docx' }, ortak);
  const hzTers = await it.hazirla({ review: 'reddiye.docx', reddiye: 'kod_review_APTY-9.md' }, ortak);
  const hzRaporDegil = await it.hazirla({ review: 'reddiye son.txt', reddiye: 'reddiye.docx' }, ortak);
  const hzBos = await it.hazirla({ review: 'kod_review_APTY-9.md', reddiye: 'bos.md' }, ortak);
  const hzBozuk = await it.hazirla({ review: 'kod_review_APTY-9.md', reddiye: 'bozuk.docx' }, ortak);
  const hzAyni = await it.hazirla({ review: 'kod_review_APTY-9.md', reddiye: 'kod_review_APTY-9.md' }, ortak);
  const docx = await it.dosyaOku(pathTest.join(ortak, 'reddiye.docx'));
  const itirazGovde = '**Ozet**\nIki itiraz.\n\n**Itirazlarin Degerlendirmesi**\n✅ 1. 🔴 SQL bulgusu: hakli\n❌ 2. bulgu gecerli\n⚖️ 3. kismen\n\n**Guncel Bulgular**\n🟠 **Dosya.java** eksik kontrol\n🟡 isimlendirme\n\n**Genel Degerlendirme**\n🔴 kalmadi';
  const gorselOzet = [{ no: 1, verilemedi: false, neden: null }, { no: 2, verilemedi: true, neden: 'desteklenmeyen bicim (emf)' }, { no: 3, verilemedi: false, neden: null }];
  const itRapor = it.raporOlustur({ branch: 'feature/APTY-9', ref: 'origin/feature/APTY-9', commitler: [commit, { ...commit, kisa: 'fff0000', yeni: true }], govde: itirazGovde, puan: 80, model: 'strata', sureSn: 9, oncekiPuan: 42, reviewDosya: 'kod_review_APTY-9.md', reddiyeDosya: 'reddiye.docx', gorseller: gorselOzet, gorselSayisi: 2, gorselReddedildi: false, metinKirpildi: false, yeniCommitler: [{ kisa: 'fff0000' }] });
  const secili = it.gorselSec(docx.gorseller, {});
  const parca = it.reddiyeParcalari(docx.metin, secili);
  const ekGorselli = it.onEk({ review: 'INC', reddiye: docx.metin, gorseller: secili });
  const ekMetin = it.onEk({ review: 'INC', reddiye: 'RED', yeniCommitler: [{ kisa: 'fff0000' }] });
  const uncKok = '\\\\172.18.247.8\\fsortak1\\BT_ORTAK\\THE_BEST_OSEMCİLER\\temp';
  const itBilgi = it.raporBilgisi(itRapor);
  const linkYolu = pathTest.join(ortak, 'link.md');
  let linkVar = true;
  try { fsTest.symlinkSync(disari, linkYolu); } catch (_) { linkVar = false; }

  const itirazCases = [
    ['arg: ayni satirda iki dosya', (() => { const a = it.argumanCoz('ortak-alan/review.md ortak-alan/reddiye.docx'); return a.review === 'ortak-alan/review.md' && a.reddiye === 'ortak-alan/reddiye.docx'; })()],
    ['arg: alt alta (boslukli ad)', (() => { const a = it.argumanCoz('kod review.md\nreddiye son.docx'); return a.review === 'kod review.md' && a.reddiye === 'reddiye son.docx'; })()],
    ['arg: tirnakli boslukli yol', (() => { const a = it.argumanCoz('"Ortak Alan/r.md" reddiye.docx'); return a.review === 'Ortak Alan/r.md' && a.reddiye === 'reddiye.docx'; })()],
    ['arg: tirnaksiz boslukli yol uzantidan ayrilir', (() => { const a = it.argumanCoz('Ortak Alan\\r.md reddiye son.DOCX'); return a.review === 'Ortak Alan\\r.md' && a.reddiye === 'reddiye son.DOCX'; })()],
    ['arg: bos', it.argumanCoz('  ').hata === 'bos'],
    ['arg: tek dosya → hata', !!it.argumanCoz('review.md').hata],
    ['dosya: ad ile bulunur', it.dosyaCoz('reddiye.docx', ortak).goreli === 'reddiye.docx'],
    ['dosya: olmayan on ek → ortak alan kokunde aranir', it.dosyaCoz('ortak-alan/reddiye.docx', ortak).goreli === 'reddiye.docx'],
    ['dosya: Webex\'in yuttugu _ isaretleri tolere edilir', it.dosyaCoz('kodreviewAPTY-9.md', ortak).goreli === 'kod_review_APTY-9.md'],
    ['dosya: tam yol (ortak alan icinde)', it.dosyaCoz(pathTest.join(ortak, 'alt', 'not.md'), ortak).goreli === pathTest.join('alt', 'not.md')],
    ['dosya: ../ ile disari cikilamaz', !!it.dosyaCoz(`../${pathTest.basename(disari)}`, ortak).hata],
    ['dosya: ortak alan disindaki tam yol reddedilir', !!it.dosyaCoz(disari, ortak).hata],
    ['dosya: disari isaret eden link reddedilir', !linkVar || !!it.dosyaCoz('link.md', ortak).hata],
    ['dosya: desteklenmeyen uzanti', (it.dosyaCoz('rapor.pdf', ortak).hata || '').includes('Desteklenmeyen')],
    ['dosya: bulunamadi', (it.dosyaCoz('yok.md', ortak).hata || '').includes('bulunamadi')],
    ['dosya: SHARED_FOLDER yoksa hata', (it.dosyaCoz('reddiye.docx', '').hata || '').includes('SHARED_FOLDER')],
    ['docx: baslik + paragraf + entity', docx.metin.startsWith('## Reddiye\n1. bulgu yanlis: a < b && c kontrolu var')],
    ['docx: liste maddesi, tab ve satir sonu', docx.metin.includes('- madde\tiki\nalt satir')],
    ['docx: silinmis metin atilir, Turkce korunur', docx.metin.includes('kalan şğı') && !docx.metin.includes('silinmis')],
    ['docx: gomulu gorseller sirayla, tekrar eden ve VML kopyasi tek sayilir', docx.gorseller.map((g) => `${g.no}:${g.ad}:${g.mime}`).join() === '1:image1.png:image/png,2:image2.emf:null,3:foto.jpeg:image/jpeg'],
    ['docx: gorselin yeri metinde isaretli', docx.metin.includes('Ekran goruntusu:\n[Gorsel 1]\n[Gorsel 2]\n[Gorsel 3]\nson\n[Gorsel 1]')],
    ['docx: desteklenmeyen bicim verilmez, nedeni yazilir', docx.gorseller[1].veri === null && docx.gorseller[1].neden === 'desteklenmeyen bicim (emf)' && Buffer.isBuffer(docx.gorseller[0].veri)],
    ['gorsel turu icerikten anlasilir', it.gorselTuru(png) === 'image/png' && it.gorselTuru(jpg) === 'image/jpeg' && it.gorselTuru(Buffer.from('GIF89a' + 'x'.repeat(10))) === 'image/gif' && it.gorselTuru(Buffer.from('RIFFxxxxWEBPVP8 ')) === 'image/webp' && it.gorselTuru(Buffer.alloc(20)) === null],
    ['gorsel secimi: varsayilan hepsi', secili.filter((g) => g.veri).length === 2],
    ['gorsel secimi: KOD_REVIEW_GORSEL=kapali', it.gorselSec(docx.gorseller, { KOD_REVIEW_GORSEL: 'kapali' }).every((g) => !g.veri && g.neden)],
    ['gorsel secimi: adet siniri', (() => { const g = it.gorselSec(docx.gorseller, { KOD_REVIEW_MAX_GORSEL: '1' }); return g[0].veri && !g[2].veri && g[2].neden.includes('en fazla 1'); })()],
    ['gorsel secimi: cok buyuk gorsel', it.gorselSec([{ no: 1, mime: 'image/png', veri: Buffer.alloc(6 * 1024 * 1024), neden: null }], {})[0].neden.includes('cok buyuk')],
    ['parcalar: metin-gorsel-metin sirasi, ayni gorsel bir kez', parca.gonderilen === 2 && parca.parcalar.map((p) => p.type).join() === 'text,image_url,text,image_url,text' && parca.parcalar[0].text.endsWith('[Gorsel 1]') && parca.parcalar[1].image_url.url === `data:image/png;base64,${png.toString('base64')}`],
    ['parcalar: verilemeyen gorselin isaretine neden yazilir', parca.parcalar[2].text.includes('[Gorsel 2 — modele verilemedi: desteklenmeyen bicim (emf)]') && parca.parcalar[2].text.endsWith('[Gorsel 3]')],
    ['on ek: gorselliyse parca dizisi', Array.isArray(ekGorselli.icerik) && ekGorselli.gonderilen === 2 && ekGorselli.icerik[0].text.includes('INC') && ekGorselli.icerik[ekGorselli.icerik.length - 1].text.includes('REDDIYE (bitis)')],
    ['gorsel notlari: gosterildi + verilemeyen', (() => { const n = it.gorselNotlari({ gorseller: gorselOzet, gorselSayisi: 2, gorselReddedildi: false }).join(' '); return n.includes('2 gorsel modele gosterildi') && n.includes('Gorsel 2 (desteklenmeyen bicim (emf))'); })()],
    ['gorsel notlari: sunucu reddetti', it.gorselNotlari({ gorseller: gorselOzet, gorselSayisi: 0, gorselReddedildi: true })[0].includes('gorsel kabul etmedi')],
    ['gorsel notlari: gorsel yoksa bos', it.gorselNotlari({ gorseller: [] }).length === 0],
    ['goreli yol: yolda İ olsa da ilk harf kesilmez (Node 20 path.relative hatasi)', it.goreliYol(uncKok, `${uncKok}\\kod_review_APTY-131487.md`, true) === 'kod_review_APTY-131487.md' && it.goreliYol(uncKok, `${uncKok}\\alt\\APTY-1.docx`, true) === 'alt\\APTY-1.docx'],
    ['goreli yol: harf duyarsiz kok (Windows)', it.goreliYol('C:\\Ortak', 'c:\\ortak\\a.md', true) === 'a.md' && it.goreliYol('C:\\Ortak', 'c:\\ortak\\a.md', false) === null],
    ['goreli yol: disarisi, kokun kendisi, benzer on ek → null', it.goreliYol('/a/b', '/a/c/x.md') === null && it.goreliYol('/a/b', '/a/b') === null && it.goreliYol('/a/b', '/a/bc/x.md') === null && it.goreliYol('/a/b/', '/a/b/x.md') === 'x.md'],
    ['icerik karakteri: metin + gorsel tahmini', ajan.icerikKarakter('abc') === 3 && ajan.icerikKarakter([{ type: 'text', text: 'abcd' }, { type: 'image_url', image_url: { url: 'x' } }]) === 4504 && ajan.mesajKarakter([{ role: 'user', content: [{ type: 'text', text: 'ab' }] }]) === 2],
    ['gorselleri at: metin birlesir + not', ajan.gorselleriAt([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }], 'N') === 'ab\n\nN' && ajan.gorselleriAt('duz', 'N') === 'duz'],
    ['413/415 de istek reddi sayilir', ajan.istekReddedildiMi({ response: { status: 413 } }) && ajan.istekReddedildiMi({ response: { status: 415 } }) && !ajan.istekReddedildiMi({ response: { status: 503 } })],
    ['txt: BOM ve CRLF temizlenir', (await it.dosyaOku(pathTest.join(ortak, 'reddiye son.txt'))).metin === 'Katilmiyorum.'],
    ['rapor bilgisi: branch + puan + commit', (() => { const b = it.raporBilgisi(rapor); return b.branch === 'feature/APTY-9' && b.puan === 42 && b.shalar.join() === 'abc1234'; })()],
    ['rapor bilgisi: bulgudaki `abc` commit sayilmaz', it.raporBilgisi(rapor).shalar.length === 1],
    ['rapor bilgisi: rapor degilse branch yok', it.raporBilgisi('duz metin').branch === null],
    ['hazirla: branch ve aranan rapordan', hz.branch === 'feature/APTY-9' && hz.aranan === 'APTY-9' && hz.oncekiPuan === 42 && hz.reddiye.gorseller.length === 3 && !hz.yerDegisti],
    ['hazirla: ters sirada verilen dosyalar duzeltilir', hzTers.yerDegisti === true && hzTers.review.goreli === 'kod_review_APTY-9.md' && hzTers.reddiye.goreli === 'reddiye.docx'],
    ['hazirla: ilk dosya rapor degilse hata', (hzRaporDegil.hata || '').includes('inceleme raporuna benzemiyor')],
    ['hazirla: bos reddiye', (hzBos.hata || '').includes('bos')],
    ['hazirla: bozuk docx', (hzBozuk.hata || '').includes('gecerli bir .docx')],
    ['hazirla: ayni dosya iki kez', (hzAyni.hata || '').includes('ayni dosya')],
    ['itiraz raporu sonraki turda okunabilir', itBilgi.branch === 'feature/APTY-9' && itBilgi.puan === 80 && itBilgi.shalar.join() === 'abc1234,fff0000'],
    ['itiraz raporunda onceki puan + dosyalar + notlar', itRapor.includes('**Onceki puan:** 42/100') && itRapor.includes('`reddiye.docx`') && itRapor.includes('1 yeni commit') && itRapor.includes('2 gorsel modele gosterildi') && itRapor.includes('## Itiraz degerlendirmesi')],
    ['kararlar sayilir', (() => { const k = it.kararSay(itirazGovde); return k.kabul === 1 && k.kismen === 1 && k.ret === 1; })()],
    ['bulgular yalnizca Guncel Bulgular bolumunden sayilir', (() => { const b = kr.bulguSay(it.guncelBulgular(itirazGovde)); return b.kritik === 0 && b.onemli === 1 && b.kucuk === 1; })()],
    ['guncel bulgular bolumu yoksa tum govde', it.guncelBulgular('🔴 a') === '🔴 a'],
    ['on ek: inceleme + reddiye + yeni commit notu (gorselsizse duz metin)', (() => { const e = ekMetin.icerik; return typeof e === 'string' && ekMetin.gonderilen === 0 && e.includes('INC') && e.includes('RED') && e.includes('1 yeni commit') && e.indexOf('INC') < e.indexOf('RED'); })()],
    ['itiraz sistem mesaji: puan olcegi + arac kurallari', kr.sistemMesaji({ araclarVar: true, temel: it.SISTEM_ITIRAZ }).includes('PUAN: <0-100') && kr.sistemMesaji({ araclarVar: true, temel: it.SISTEM_ITIRAZ }).includes('dosya_oku') && it.SISTEM_ITIRAZ.includes('Guncel Bulgular')],
    ['buyuk diff hesabina ek metin dahil', !kr.buyukDiffMi('x'.repeat(100), 100) && kr.buyukDiffMi('x'.repeat(100), 100, 100)],
    ['rapor dosya adina tur eklenir', (() => { const eski = process.env.SHARED_FOLDER; process.env.SHARED_FOLDER = ortak; const d = kr.dosyayaYaz('feature/APTY-9', 'x', 'itiraz'); if (eski === undefined) delete process.env.SHARED_FOLDER; else process.env.SHARED_FOLDER = eski; return /kod_review_feature_APTY-9_itiraz_\d{4}-/.test(pathTest.basename(d || '')); })()],
  ];
  fsTest.rmSync(ortak, { recursive: true, force: true });
  fsTest.rmSync(disari, { force: true });

  let itirazPass = 0;
  for (const [desc, ok] of itirazCases) {
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
    if (ok) itirazPass++;
  }
  console.log(`\nItiraz (5-2): ${itirazPass}/${itirazCases.length} gecti`);
})().catch((err) => console.log(`FAIL | itiraz testleri calismadi: ${err.stack}`));

// Ajan dongusu: yerel sahte sunucu (ag disina cikmaz). Arac cagrisi → sonuc →
// compact → nihai cevap; compact sonrasi gecmisin sistem+gorev+ozet+devam oldugu.
(() => {
  const http = require('http');
  const istekler = [];
  const sunucu = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b);
      istekler.push(j);
      const son = j.messages[j.messages.length - 1].content || '';
      let mesaj;
      if (son.includes('sikistirilacak')) mesaj = { role: 'assistant', content: 'OZET' };
      else if (istekler.length === 1) mesaj = { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'yankila', arguments: '{"x":"' + 'y'.repeat(3000) + '"}' } }] };
      else mesaj = { role: 'assistant', content: '<think>.</think>PUAN: 90/100\nTamam' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: mesaj }] }));
    });
  });
  sunucu.listen(0, '127.0.0.1', async () => {
    const ayar = { ...kr.llmAyarlari({}), baseURL: `http://127.0.0.1:${sunucu.address().port}/v1`, reasoning: '' };
    const kontrol = (desc, ok) => console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
    try {
      const r = await ajan.ajanCalistir({
        ayar, sistem: 'S', kullanici: 'G', baglamPenceresi: 1200,
        araclar: [{ tanim: { type: 'function', function: { name: 'yankila', parameters: {} } }, calistir: async ({ x }) => x }],
      });
      const sonIstek = istekler[istekler.length - 1];
      kontrol('ajan: nihai cevap + think temizlendi', r.metin === 'PUAN: 90/100\nTamam');
      kontrol('ajan: arac calisti', r.aracKayitlari.length === 1 && r.aracKayitlari[0].ad === 'yankila');
      kontrol('ajan: compact yapildi', r.sikistirma === 1 && istekler.some((j) => j.tool_choice === 'none'));
      kontrol('ajan: compact sonrasi gecmis', sonIstek.messages.map((m) => m.role).join(',') === 'system,user,assistant,user' && sonIstek.messages[2].content.includes('OZET'));
      kontrol('ajan: tool_call/tool cifti eslesti', istekler[1].messages[2].tool_calls[0].id === istekler[1].messages[3].tool_call_id);
    } catch (err) {
      kontrol(`ajan dongusu (${err.message})`, false);
    } finally {
      sunucu.close();
    }
  });
})();

// Ajan dongusu: sunucu gorselli istegi reddederse (400) gorseller atilip araclarla devam edilir.
(() => {
  const http = require('http');
  const istekler = [];
  const gorselliMi = (j) => Array.isArray(j.messages[1].content) && j.messages[1].content.some((p) => p.type === 'image_url');
  const sunucu = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b);
      istekler.push(j);
      res.setHeader('content-type', 'application/json');
      if (gorselliMi(j)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'image input is not supported' }));
        return;
      }
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'PUAN: 70/100\nTamam' } }] }));
    });
  });
  sunucu.listen(0, '127.0.0.1', async () => {
    const ayar = { ...kr.llmAyarlari({}), baseURL: `http://127.0.0.1:${sunucu.address().port}/v1`, reasoning: '' };
    const kontrol = (desc, ok) => console.log(`${ok ? 'PASS' : 'FAIL'} | ${desc}`);
    const gorselliGorev = [{ type: 'text', text: 'Bak: [Gorsel 1]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: ' bitti' }];
    try {
      const r = await ajan.ajanCalistir({
        ayar, sistem: 'S', kullanici: gorselliGorev, gorselsizNot: 'GORSEL YOK',
        araclar: [{ tanim: { type: 'function', function: { name: 'yankila', parameters: {} } }, calistir: async () => 'x' }],
      });
      kontrol('ajan: gorsel reddedilince metinle devam', r.metin === 'PUAN: 70/100\nTamam' && r.gorselReddedildi === true && r.gorselSayisi === 0);
      kontrol('ajan: ilk istek gorselli, ikincisi gorselsiz + not', istekler.length === 2 && gorselliMi(istekler[0]) && istekler[1].messages[1].content === 'Bak: [Gorsel 1] bitti\n\nGORSEL YOK');
      kontrol('ajan: gorsel reddinde araclar korunur', r.aracsiz === false && Array.isArray(istekler[1].tools));
    } catch (err) {
      kontrol(`ajan gorsel geri dususu (${err.message})`, false);
    } finally {
      sunucu.close();
    }
  });
})();

// LLM_BASE_URL yoksa ag cagrisi yapilmadan anlasilir hata verilmeli.
kr.llmIncele({ branch: 'X-1', commitler: [], diff: '' }, {})
  .then(() => console.log('FAIL | LLM_BASE_URL yoksa hata'))
  .catch((err) => console.log(`${err.message.includes('LLM_BASE_URL') ? 'PASS' : 'FAIL'} | LLM_BASE_URL yoksa hata`));

// tempPassword modulu yuklenebiliyor mu?
require('./lib/tempPassword');
console.log('lib/tempPassword.js yuklendi.');
console.log('Env kontrol: PROD_LOGIN_URI =', process.env.PROD_LOGIN_URI ? 'OK' : 'EKSIK');
console.log('Env kontrol: SHARED_FOLDER =', process.env.SHARED_FOLDER ? 'OK' : 'EKSIK');
