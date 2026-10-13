'use strict';

/**
 * 8. islem — Makara (botlar arasi kopru).
 *
 * Kullanici gruptan "8 <metin>" der; bot bu metni KOPRU ODASINDA hedef botu
 * (MakaraMiyizAbi) ETIKETLEYEREK yazar, hedef botun cevabini bekler ve
 * istegi atan kisiye geri doner. Yani bu bot iki Webex botu arasinda mesaj
 * tasiyan bir kopru gibi calisir.
 *
 * Cevabi yakalama yollari (ucu birlikte yarisir):
 *  1. THREAD YOKLAMASI (asil kanal) — kendi mesajimizin thread'i REST ile
 *     taranir: `GET /messages?roomId=<kopru>&parentId=<bizim mesaj>`.
 *     Bot token'i odayi filtresiz listeleyemez (403) ama kendi mesajinin
 *     thread'ini listeleyebilir. Karsi bot `bot.reply` kullandigi icin
 *     (thread'e cevap, etiket YOK) cevap burada gorunur — olculdu 2026-09-11.
 *  2. Websocket — hedef bot cevabinda BIZI etiketlerse framework mesaji
 *     aninda getirir. index.js kopru odasi mesajlarini `cevapGeldi()`ye verir.
 *  3. `WEBEX_USER_TOKEN` gecerliyse odanin tamami taranir; boylece thread
 *     disina, etiketsiz yazilan cevaplar da yakalanir. Token yoksa/expired
 *     ise 1 ve 2 yeter (token zorunlu DEGIL).
 */

const axios = require('axios');

const WEBEX_API = 'https://webexapis.com/v1';

// Kopru odasi ("Botlarim") — env ile degistirilebilir.
const VARSAYILAN_KOPRU_ODA =
  'Y2lzY29zcGFyazovL3VzL1JPT00vMzkwMGQ0NzAtYWRhOS0xMWYxLWE2OGUtMGRlOTg1NjAyN2Rh';

// Hedef botun gorunen adi. Karsilastirma Turkce karakterler sadelestirilerek
// yapilir, bu yuzden burada ASCII yazilabilir.
const VARSAYILAN_HEDEF_AD = 'MakaraMiyizAbi';

// Karsi bot LLM ile cevap uretiyor: olculen cevap suresi ~53 sn (2026-09-11).
const ZAMAN_ASIMI_MS = Number(process.env.MAKARA_TIMEOUT_MS) || 150000;
// Asil kanal websocket; yoklama yedek oldugu icin seyrek. 3 sn'de bir
// denenince Webex 429 veriyordu (olculdu 2026-09-11).
const YOKLAMA_ARALIGI_MS = 6000;
const YOKLAMA_429_BEKLEME_MS = 30000; // Retry-After yoksa kullanilir
const ISTEK_ZAMAN_ASIMI_MS = 15000;

// Webex tek mesajda ~7439 karakter kabul ediyor; guvenli tarafta kalalim.
const WEBEX_LIMIT = 7000;
const MAX_ISTEK_UZUNLUGU = 1000;

let hedefCache = null; // {id, ad, email}
let kullaniciTokenBozuk = false; // 401 alindiysa bir daha denenmez
let mesgul = false;

// Websocket'ten gelen cevabi bekleyenler: {hedefId, sonrasi, coz}
const bekleyenler = [];

function kopruOdaId() {
  return (process.env.WEBEX_KOPRU_ODA_ID || VARSAYILAN_KOPRU_ODA).trim();
}

function hedefAd() {
  return (process.env.MAKARA_BOT_ADI || VARSAYILAN_HEDEF_AD).trim();
}

function botToken() {
  return process.env.WEBEX_BOT_TOKEN;
}

function kullaniciToken() {
  const t = (process.env.WEBEX_USER_TOKEN || '').trim();
  return !t || kullaniciTokenBozuk ? null : t;
}

/** Turkce karakterleri sadelestirip kucultur (ad karsilastirmasi icin). */
function sadelestir(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[ıİ]/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/\s+/g, '');
}

async function webexGet(yol, params, token) {
  return axios.get(`${WEBEX_API}${yol}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: ISTEK_ZAMAN_ASIMI_MS,
    validateStatus: () => true,
  });
}

/**
 * Kopru odasindaki hedef botu bulur (gorunen ada gore). Sonuc bellekte
 * saklanir; `MAKARA_BOT_ID` verilmisse dogrudan o kullanilir.
 */
async function hedefiBul() {
  if (hedefCache) return hedefCache;

  const zorlananId = (process.env.MAKARA_BOT_ID || '').trim();
  if (zorlananId) {
    hedefCache = { id: zorlananId, ad: hedefAd(), email: null };
    return hedefCache;
  }

  if (!botToken()) throw new Error('WEBEX_BOT_TOKEN tanimli degil.');

  const res = await webexGet('/memberships', { roomId: kopruOdaId(), max: 100 }, botToken());
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.items)) {
    throw new Error(
      `Kopru odasinin uyeleri okunamadi (HTTP ${res.status}). ` +
        'Bot kopru odasinda olmayabilir ya da WEBEX_KOPRU_ODA_ID hatali olabilir.'
    );
  }

  const aranan = sadelestir(hedefAd());
  const uye = res.data.items.find((m) => sadelestir(m.personDisplayName) === aranan);

  if (!uye) {
    const adlar = res.data.items.map((m) => m.personDisplayName).join(', ') || '(bos)';
    throw new Error(
      `Kopru odasinda "${hedefAd()}" adli bot yok. Odadaki uyeler: ${adlar}. ` +
        'Farkli bir bot icin .env > MAKARA_BOT_ADI kullanin.'
    );
  }

  hedefCache = { id: uye.personId, ad: uye.personDisplayName, email: uye.personEmail || null };
  return hedefCache;
}

/**
 * Kullanicidan gelen metni kopruye yazilabilir hale getirir: etiket
 * sozdizimi (`<@personId:...>`) enjeksiyonu kirilir, uzunluk sinirlanir.
 */
function temizle(metin) {
  let t = (metin || '').replace(/\r\n/g, '\n').trim();
  t = t.replace(/<@/g, '@'); // istemedigimiz kisiler etiketlenmesin
  if (t.length > MAX_ISTEK_UZUNLUGU) t = `${t.slice(0, MAX_ISTEK_UZUNLUGU)}...`;
  return t;
}

/** Kopru odasina hedef botu etiketleyerek mesaj yazar. */
async function gonder(hedef, metin) {
  const res = await axios.post(
    `${WEBEX_API}/messages`,
    {
      roomId: kopruOdaId(),
      markdown: `<@personId:${hedef.id}> ${metin}`,
    },
    {
      headers: { Authorization: `Bearer ${botToken()}`, 'Content-Type': 'application/json' },
      timeout: ISTEK_ZAMAN_ASIMI_MS,
      validateStatus: () => true,
    }
  );

  if (res.status !== 200) {
    const detay =
      res.data && res.data.message ? res.data.message : JSON.stringify(res.data || {}).slice(0, 200);
    throw new Error(`Kopru odasina mesaj yazilamadi (HTTP ${res.status}): ${detay}`);
  }
  return res.data;
}

/**
 * Websocket'ten gelen kopru odasi mesajini bekleyenlere dagitir.
 * index.js her kopru odasi mesajinda bunu cagirir.
 * @returns {boolean} mesaj bir bekleyene verildi mi
 */
function cevapGeldi({ roomId, personId, text, created }) {
  if (roomId !== kopruOdaId() || !personId) return false;
  if (hedefCache && personId !== hedefCache.id) return false;

  const zaman = created ? new Date(created).getTime() : Date.now();
  const kayit = bekleyenler.find((b) => b.hedefId === personId && zaman >= b.sonrasi - 2000);
  if (!kayit) return false;

  kayit.coz({ metin: (text || '').trim(), kaynak: 'websocket' });
  return true;
}

/**
 * REST ile hedef botun yeni cevabini arar.
 * @returns {Promise<{cevap: object|null, ekBekleme: number}>} ekBekleme = 429
 *   sonrasi bir sonraki denemeden once beklenecek ek sure (ms).
 */
async function yoklamaylaAra(hedef, sonrasi, kendiMesajId) {
  const kToken = kullaniciToken();
  const token = kToken || botToken();
  // Bot token'i odayi filtresiz listeleyemez (403) AMA kendi mesajinin
  // THREAD'ini listeleyebilir (`parentId`) — olculdu 2026-09-11. Karsi bot
  // `bot.reply` kullandigi icin cevap tam olarak orada duruyor; etiket
  // atmasina gerek kalmiyor. Kullanici token'i varsa odanin tamami taranir
  // (thread disina yazilan cevaplar da yakalanir).
  const params = kToken
    ? { roomId: kopruOdaId(), max: 20 }
    : { roomId: kopruOdaId(), parentId: kendiMesajId, max: 20 };

  // parentId yoksa (mesaj id'si alinamadiysa) etiketli mesajlara bakilir.
  if (!kToken && !kendiMesajId) {
    delete params.parentId;
    params.mentionedPeople = 'me';
  }

  const res = await webexGet('/messages', params, token);

  if (res.status === 401 && kToken) {
    kullaniciTokenBozuk = true;
    console.error(
      'Makara: WEBEX_USER_TOKEN gecersiz/suresi dolmus — bot token ile thread ' +
        'kanalindan devam ediliyor.'
    );
    // Bu turu bosa harcamayalim: ayni anda bot token ile tekrar dene.
    return yoklamaylaAra(hedef, sonrasi, kendiMesajId);
  }

  if (res.status === 429) {
    const basliktan = Number((res.headers || {})['retry-after']) * 1000;
    const ekBekleme = Number.isFinite(basliktan) && basliktan > 0 ? basliktan : YOKLAMA_429_BEKLEME_MS;
    console.error(`Makara: Webex 429 verdi, yoklama ${Math.round(ekBekleme / 1000)} sn bekletiliyor.`);
    return { cevap: null, ekBekleme };
  }

  if (res.status !== 200 || !res.data || !Array.isArray(res.data.items)) {
    return { cevap: null, ekBekleme: 0 };
  }

  const adaylar = res.data.items
    .filter((m) => m.personId === hedef.id && m.id !== kendiMesajId)
    .filter((m) => new Date(m.created).getTime() >= sonrasi - 2000)
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  if (adaylar.length === 0) return { cevap: null, ekBekleme: 0 };

  const m = adaylar[0];
  return {
    cevap: { metin: (m.text || '').trim(), kaynak: kToken ? 'yoklama(oda)' : 'yoklama(thread)' },
    ekBekleme: 0,
  };
}

function bekle(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Hedef botun cevabini bekler: websocket ve yoklama birlikte yarisir.
 * Cevap gelmezse null doner.
 */
async function cevapBekle(hedef, gonderim) {
  const sonrasi = gonderim && gonderim.created ? new Date(gonderim.created).getTime() : Date.now();
  const bitis = Date.now() + ZAMAN_ASIMI_MS;

  const kayit = { hedefId: hedef.id, sonrasi, coz: null };
  let websocketCevabi = null;
  new Promise((resolve) => {
    kayit.coz = resolve;
  }).then((c) => {
    websocketCevabi = c;
  });
  bekleyenler.push(kayit);

  try {
    let ekBekleme = 0;
    while (Date.now() < bitis) {
      // 429 sonrasi bekleme websocket'i engellemesin diye parcali beklenir.
      const beklenecek = YOKLAMA_ARALIGI_MS + ekBekleme;
      ekBekleme = 0;
      for (let gecen = 0; gecen < beklenecek; gecen += YOKLAMA_ARALIGI_MS) {
        await bekle(Math.min(YOKLAMA_ARALIGI_MS, beklenecek - gecen));
        if (websocketCevabi) return websocketCevabi;
      }

      try {
        const sonuc = await yoklamaylaAra(hedef, sonrasi, gonderim && gonderim.id);
        if (sonuc.cevap) return sonuc.cevap;
        ekBekleme = sonuc.ekBekleme;
      } catch (err) {
        console.error(`Makara yoklamasi basarisiz: ${err.message}`);
      }
      if (websocketCevabi) return websocketCevabi;
    }

    return null;
  } finally {
    const i = bekleyenler.indexOf(kayit);
    if (i !== -1) bekleyenler.splice(i, 1);
  }
}

function mesgulMu() {
  return mesgul;
}

function kisalt(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 40)}\n\n_... cevap uzun oldugu icin kisaltildi._`;
}

/** Hedef botun cevabinin basindaki bizim etiketimizi (bot adini) temizler. */
function cevabiTemizle(metin, botAdi) {
  let t = (metin || '').trim();
  if (botAdi) {
    const re = new RegExp(`^${botAdi.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,:]?\\s*`, 'i');
    t = t.replace(re, '').trim();
  }
  return t;
}

/**
 * 8. islemin govdesi: metni kopruye yazar, hedef botun cevabini getirir.
 * @param {{metin: string, botAdi?: string}} param0
 * @returns {Promise<{ok: boolean, kim: string, cevap?: string, hata?: string, kaynak?: string}>}
 */
async function makaraYap({ metin, botAdi }) {
  const temiz = temizle(metin);
  if (!temiz) return { ok: false, kim: hedefAd(), hata: 'Bos mesaj kopruye yazilmaz.' };

  if (mesgul) {
    return {
      ok: false,
      kim: hedefAd(),
      hata: 'Kopruden zaten bir makara bekleniyor. Cevap gelince tekrar deneyin.',
    };
  }

  mesgul = true;
  try {
    const hedef = await hedefiBul();
    const gonderim = await gonder(hedef, temiz);
    const cevap = await cevapBekle(hedef, gonderim);

    if (!cevap) {
      return {
        ok: false,
        kim: hedef.ad,
        hata:
          `${hedef.ad} ${Math.round(ZAMAN_ASIMI_MS / 1000)} saniye icinde cevap vermedi.\n\n` +
          '_Not: cevap thread icinde ya da beni etiketleyerek gelirse okunabilir. ' +
          'Karsi bot ayri bir mesaj olarak (thread disi, etiketsiz) yaziyorsa ' +
          'cevabi gorebilmem icin `.env` > `WEBEX_USER_TOKEN` guncel olmali._',
      };
    }

    return {
      ok: true,
      kim: hedef.ad,
      cevap: kisalt(cevabiTemizle(cevap.metin, botAdi), WEBEX_LIMIT),
      kaynak: cevap.kaynak,
    };
  } catch (err) {
    return { ok: false, kim: hedefAd(), hata: err.message };
  } finally {
    mesgul = false;
  }
}

module.exports = {
  makaraYap,
  cevapGeldi,
  mesgulMu,
  yoklamaylaAra, // dogrulama/test icin; normal akista makaraYap kullanilir
  kopruOdaId,
  hedefAd,
  hedefiBul,
  temizle,
  sadelestir,
  cevabiTemizle,
  ZAMAN_ASIMI_MS,
};
