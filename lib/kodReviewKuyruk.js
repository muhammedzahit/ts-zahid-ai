'use strict';

// 5. islem (kod incelemesi) kuyrugu.
//
// Talepler hemen calismaz: kuyruga girer, yetkili kisi `5 onay` deyince sirayla
// islenir (yerel yapay zeka her zaman acik degil). Talepler varsayilan 24 saat bekler.
//
// Bot iki makinede calisabildigi icin kuyruk bir KLASORDUR (iki makinede ayni ag
// yolu verilir) ve her talep ayri bir dosyadir:
//   <eklenmeMs>_<id>.json            bekleyen talep
//   <eklenmeMs>_<id>.json.isleniyor  su an islenen talep
//   .sahiplik/<webexMesajId>         bu mesaji hangi makinenin isleyecegi
// Dosyalar `wx` (yalnizca yoksa olustur) ile yazildigi ve tek dosya uzerinde
// oku-degistir-yaz yapilmadigi icin iki makine ayni anda calissa da kilit gerekmez.
// Ayni mesaji iki makine de alir; `.sahiplik` dosyasini ilk olusturan isler,
// digeri sessiz kalir.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeName } = require('./approvers');

const VARSAYILAN_KLASOR = path.join(__dirname, '..', 'data', 'kodReviewKuyruk');
const SAHIPLIK = '.sahiplik';
const SAHIPLIK_OMUR_MS = 48 * 60 * 60 * 1000;
const ISLENIYOR = '.isleniyor';

function klasor(env = process.env) {
  return (env.KOD_REVIEW_KUYRUK_KLASORU || '').trim() || VARSAYILAN_KLASOR;
}

/** Talebin kuyrukta bekleyebilecegi sure (ms). */
function bekleme(env = process.env) {
  const saat = Number(env.KOD_REVIEW_KUYRUK_SURE_SAAT);
  return (Number.isFinite(saat) && saat > 0 ? saat : 24) * 60 * 60 * 1000;
}

function hazirla(k) {
  fs.mkdirSync(path.join(k, SAHIPLIK), { recursive: true });
}

function sahiplikTemizle(k, simdi = Date.now()) {
  const d = path.join(k, SAHIPLIK);
  let adlar;
  try {
    adlar = fs.readdirSync(d);
  } catch (_) {
    return;
  }
  for (const ad of adlar) {
    try {
      const yol = path.join(d, ad);
      if (simdi - fs.statSync(yol).mtimeMs > SAHIPLIK_OMUR_MS) fs.unlinkSync(yol);
    } catch (_) {
      /* baska makine silmis olabilir */
    }
  }
}

function sahiplikYolu(anahtar, k) {
  const ad = String(anahtar).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  return path.join(k, SAHIPLIK, ad);
}

/**
 * Mesaji bu makine icin sahiplenir. true → bu makine isler; false → baska makine
 * zaten sahiplendi, sessiz kal. Klasore erisilemezse hata firlatir.
 */
function sahiplen(anahtar, k = klasor()) {
  hazirla(k);
  sahiplikTemizle(k);
  try {
    fs.closeSync(fs.openSync(sahiplikYolu(anahtar, k), 'wx'));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function sahiplenildiMi(anahtar, k = klasor()) {
  return fs.existsSync(sahiplikYolu(anahtar, k));
}

function oku(k, ad) {
  try {
    const veri = JSON.parse(fs.readFileSync(path.join(k, ad), 'utf8'));
    return { ...veri, dosya: ad.endsWith(ISLENIYOR) ? ad.slice(0, -ISLENIYOR.length) : ad };
  } catch (_) {
    return null; // yarim yazilmis / silinmis dosya
  }
}

function adlar(k) {
  try {
    return fs.readdirSync(k).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Bekleyen talepler, eklenme sirasiyla. */
function bekleyenler(k = klasor()) {
  return adlar(k).filter((a) => a.endsWith('.json')).map((a) => oku(k, a)).filter(Boolean);
}

/** Su an islenmekte olan talepler. */
function isleniyorlar(k = klasor()) {
  return adlar(k).filter((a) => a.endsWith(`.json${ISLENIYOR}`)).map((a) => oku(k, a)).filter(Boolean);
}

/**
 * Kuyruga talep ekler.
 * @param {{branch, aranan, roomId, kim, kimEmail}} talep
 */
function ekle(talep, k = klasor(), simdi = Date.now()) {
  hazirla(k);
  for (let deneme = 0; deneme < 5; deneme++) {
    const id = crypto.randomBytes(3).toString('hex');
    const dosya = `${simdi}_${id}.json`;
    const kayit = { id, ...talep, eklenme: simdi };
    try {
      fs.writeFileSync(path.join(k, dosya), JSON.stringify(kayit, null, 2), { flag: 'wx' });
      return { ...kayit, dosya };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Kuyruga eklenemedi (benzersiz ad uretilemedi).');
}

/** "#a1b2c3", "a1b2c3" ya da branch adiyla bekleyen talebi bulur. */
function bul(hedef, k = klasor()) {
  const h = String(hedef || '').trim().replace(/^#/, '').toLowerCase();
  if (!h) return null;
  return bekleyenler(k).find((t) => t.id === h || String(t.branch).toLowerCase() === h) || null;
}

function sil(talep, k = klasor()) {
  try {
    fs.unlinkSync(path.join(k, talep.dosya));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Bekleyen talebi "isleniyor" yapar. false → talep artik yok (iptal edilmis). */
function isleniyorIsaretle(talep, k = klasor()) {
  try {
    fs.renameSync(path.join(k, talep.dosya), path.join(k, talep.dosya + ISLENIYOR));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Islenen talebi tekrar bekleyenlere alir (baglanti koptugunda). */
function geriAl(talep, k = klasor()) {
  try {
    fs.renameSync(path.join(k, talep.dosya + ISLENIYOR), path.join(k, talep.dosya));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Islenmesi biten talebi siler. */
function isleniyorSil(talep, k = klasor()) {
  try {
    fs.unlinkSync(path.join(k, talep.dosya + ISLENIYOR));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Yarim kalmis (bot cokmus) islemleri bekleyenlere geri alir. Kac tane dondugunu verir. */
function kurtar(k = klasor()) {
  let n = 0;
  for (const t of isleniyorlar(k)) if (geriAl(t, k)) n += 1;
  return n;
}

/** Bekleme suresi dolan talepleri kuyruktan cikarir ve dondurur. */
function sureDolanlariAyikla(k = klasor(), sure = bekleme(), simdi = Date.now()) {
  const dolan = [];
  for (const t of bekleyenler(k)) {
    if (simdi - Number(t.eklenme) > sure && sil(t, k)) dolan.push(t);
  }
  return dolan;
}

/** `5 onay` verebilecek kisi mi? KOD_REVIEW_ONAYLAYANLAR: e-posta ya da gorunen ad, virgulle. */
function onaylayanlar(env = process.env) {
  return (env.KOD_REVIEW_ONAYLAYANLAR || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function onaylayiciMi({ email, ad }, env = process.env) {
  const e = String(email || '').trim().toLowerCase();
  const n = normalizeName(ad);
  return onaylayanlar(env).some((o) => (o.includes('@') ? o.toLowerCase() === e && !!e : !!n && normalizeName(o) === n));
}

/**
 * `5 ...` parametresini alt komuta cevirir.
 * @returns {{tur: 'bos'|'onay'|'liste'|'iptal'|'ekle', hedef?: string, girdi?: string}}
 */
function altKomutCoz(rest) {
  const metin = String(rest || '').trim();
  const [ilk = '', ikinci = ''] = metin.split(/\s+/);
  const k = ilk.toLocaleLowerCase('tr-TR');
  if (!k) return { tur: 'bos' };
  if (k === 'onay' || k === 'onayla') return { tur: 'onay' };
  if (k === 'liste' || k === 'kuyruk' || k === 'listele') return { tur: 'liste' };
  if (k === 'iptal' || k === 'sil') return { tur: 'iptal', hedef: ikinci };
  return { tur: 'ekle', girdi: metin };
}

/** 7_380_000 → "2 sa 3 dk" */
function sureYaz(ms) {
  const dk = Math.max(0, Math.round(ms / 60000));
  if (dk < 60) return `${dk} dk`;
  const sa = Math.floor(dk / 60);
  return dk % 60 ? `${sa} sa ${dk % 60} dk` : `${sa} sa`;
}

module.exports = {
  klasor,
  bekleme,
  sahiplen,
  sahiplenildiMi,
  ekle,
  bekleyenler,
  isleniyorlar,
  bul,
  sil,
  isleniyorIsaretle,
  geriAl,
  isleniyorSil,
  kurtar,
  sureDolanlariAyikla,
  onaylayanlar,
  onaylayiciMi,
  altKomutCoz,
  sureYaz,
};
