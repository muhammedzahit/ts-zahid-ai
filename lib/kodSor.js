'use strict';

/**
 * 9. islem — Jira/kod tarihcesi sorusu sor.
 *
 * Localhost'ta calisan osem-kod-bot servisine soruyu iletir. Servis, jira
 * crawler verisi ve bare git klonlari uzerinde ajan araclariyla dolasip
 * Turkce cevap uretir.
 *
 * Iki tur soru: tarihce ("iskontolarda son jiralarda ne degisti") ve mevcut
 * durum ("iskonto sifirlama kurali nasil calisiyor").
 *
 * Servis: C:\Users\T008356\Desktop\osem_kod_bot  (pm2: osem-kod-bot)
 */

const axios = require('axios');

const VARSAYILAN_URL = 'http://127.0.0.1:8849';
// Tarihce sorulari cok adimli: ara -> talepleri oku -> her birinin DIFF'ini
// oku (buyuk talepte sayfa sayfa) -> ozetle. Diff okuma eklenmeden once
// olculen sure 85-150 sn'ydi; kod icerigi okundugu icin bunun katlari
// surebiliyor. Kasitli olarak genis tutuldu - derinlik sureden onemli.
const ZAMAN_ASIMI_MS = 1200000; // 20 dk

// Webex tek mesajda ~7439 karakter kabul ediyor; guvenli tarafta kalalim.
const WEBEX_LIMIT = 7000;

function servisUrl() {
  return (process.env.KOD_SOR_URL || VARSAYILAN_URL).replace(/\/+$/, '');
}

/**
 * Soruyu servise iletir.
 * @returns {Promise<{ok: boolean, mesaj: string}>}
 */
async function askKodQuestion({ soru, kullanici, oturum }) {
  if (!soru || !soru.trim()) {
    return {
      ok: false,
      mesaj:
        '9. islem icin ikinci satira sorunuzu yazmalisiniz.\n\n' +
        'Ornek:\n```\n9\niskontolarda son jiralarda hangi guncellemeler yapildi\n```\n' +
        '```\n9\niskonto sifirlama kurali nasil calisiyor\n```',
    };
  }

  let res;
  try {
    res = await axios.post(
      `${servisUrl()}/sor`,
      { soru: soru.trim(), kullanici, oturum },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: ZAMAN_ASIMI_MS,
        validateStatus: () => true,
      }
    );
  } catch (err) {
    const kapali = err.code === 'ECONNREFUSED';
    return {
      ok: false,
      mesaj: kapali
        ? `❌ Kod soru servisi calismiyor (${servisUrl()}).\n\nSunucuda \`pm2 start osem-kod-bot\` ile baslatilmali.`
        : `❌ Kod soru servisine ulasilamadi: \`${err.code || err.message}\``,
    };
  }

  const govde = res.data || {};

  if (res.status === 429) {
    return { ok: false, mesaj: `⏳ ${govde.hata || 'Claude kotasi dolmus, bir sure sonra tekrar deneyin.'}` };
  }
  if (res.status === 503) {
    return { ok: false, mesaj: `⚠️ ${govde.hata || 'Servis hazir degil.'}` };
  }
  if (res.status !== 200 || !govde.ok) {
    return { ok: false, mesaj: `❌ ${govde.hata || `Servis ${res.status} dondu.`}` };
  }

  return { ok: true, mesaj: bicimlendir(govde, soru) };
}

/** Servis cevabini Webex markdown'ina cevirir. */
function bicimlendir(govde, soru) {
  const parcalar = [];

  parcalar.push(`💬 **${kisalt(soru.trim(), 200)}**`);

  for (const u of govde.uyarilar || []) parcalar.push(`\n⚠️ ${u}`);

  parcalar.push('\n' + (govde.metin || '').trim());

  // Hangi taleplere bakildi ve ne kadar surdu - cevabin dayanagini gorunur
  // kilar. Talep listesi uzayabiliyor, ilk birkaci yeter.
  const meta = [];
  if (govde.talepler && govde.talepler.length) {
    const ilk = govde.talepler.slice(0, 8).join(', ');
    const kalan = govde.talepler.length - 8;
    meta.push(`bakilan talepler: ${ilk}${kalan > 0 ? ` (+${kalan})` : ''}`);
  }
  if (govde.sure) meta.push(`${(govde.sure / 1000).toFixed(0)} sn`);
  if (meta.length) parcalar.push(`\n_${meta.join(' · ')}_`);

  return kisalt(parcalar.join('\n'), WEBEX_LIMIT);
}

function kisalt(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 60)}\n\n_… cevap uzun oldugu icin kisaltildi._`;
}

module.exports = { askKodQuestion };
