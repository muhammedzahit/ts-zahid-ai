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

// LLM_BASE_URL yoksa ag cagrisi yapilmadan anlasilir hata verilmeli.
kr.llmIncele({ branch: 'X-1', commitler: [], diff: '' }, {})
  .then(() => console.log('FAIL | LLM_BASE_URL yoksa hata'))
  .catch((err) => console.log(`${err.message.includes('LLM_BASE_URL') ? 'PASS' : 'FAIL'} | LLM_BASE_URL yoksa hata`));

// tempPassword modulu yuklenebiliyor mu?
require('./lib/tempPassword');
console.log('lib/tempPassword.js yuklendi.');
console.log('Env kontrol: PROD_LOGIN_URI =', process.env.PROD_LOGIN_URI ? 'OK' : 'EKSIK');
console.log('Env kontrol: SHARED_FOLDER =', process.env.SHARED_FOLDER ? 'OK' : 'EKSIK');
