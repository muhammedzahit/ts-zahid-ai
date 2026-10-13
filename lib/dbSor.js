'use strict';

/**
 * 5. islem — DB sorusu sor.
 *
 * Localhost'ta calisan osem-db-bot servisine soruyu iletir, donen SQL'i
 * kullaniciya gosterir. Servis sorguyu CALISTIRMAZ; kullanici isterse
 * 2. islemle prod'da calistirir.
 *
 * Servis: C:\Users\T008356\Desktop\osem_db_bot  (pm2: osem-db-bot)
 */

const axios = require('axios');

const VARSAYILAN_URL = 'http://127.0.0.1:8848';
const ZAMAN_ASIMI_MS = 180000; // Opus 5 + effort:high, birkac dosya okumasi 30-60sn surebiliyor

// Webex tek mesajda ~7439 karakter kabul ediyor; guvenli tarafta kalalim.
const WEBEX_LIMIT = 7000;

function servisUrl() {
  return (process.env.DB_SOR_URL || VARSAYILAN_URL).replace(/\/+$/, '');
}

/**
 * Soruyu servise iletir.
 * @returns {Promise<{ok: boolean, mesaj: string}>}
 */
async function askDbQuestion({ soru, kullanici, oturum }) {
  if (!soru || !soru.trim()) {
    return {
      ok: false,
      mesaj:
        '5. islem icin ikinci satira sorunuzu yazmalisiniz.\n\n' +
        'Ornek:\n```\n5\nsu username\'e sahip kullanicinin yetkisi ne?\n```',
    };
  }

  let res;
  try {
    res = await axios.post(
      `${servisUrl()}/sor`,
      { soru: soru.trim(), kullanici, oturum },
      { headers: { 'Content-Type': 'application/json' }, timeout: ZAMAN_ASIMI_MS, validateStatus: () => true }
    );
  } catch (err) {
    const kapali = err.code === 'ECONNREFUSED';
    return {
      ok: false,
      mesaj: kapali
        ? `❌ DB soru servisi calismiyor (${servisUrl()}).\n\nSunucuda \`pm2 start osem-db-bot\` ile baslatilmali.`
        : `❌ DB soru servisine ulasilamadi: \`${err.code || err.message}\``,
    };
  }

  const govde = res.data || {};

  if (res.status === 429) {
    return { ok: false, mesaj: `⏳ ${govde.hata || 'Claude kotasi dolmus, bir sure sonra tekrar deneyin.'}` };
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

  // govde.metin zaten ```sql blogu + aciklama iceriyor.
  parcalar.push('\n' + (govde.metin || '').trim());

  const meta = [];
  if (govde.tablolar && govde.tablolar.length) {
    meta.push(`tablolar: ${govde.tablolar.slice(0, 6).join(', ')}`);
  }
  if (govde.sure) meta.push(`${(govde.sure / 1000).toFixed(0)} sn`);
  if (meta.length) parcalar.push(`\n_${meta.join(' · ')}_`);

  if (govde.sql) {
    parcalar.push('\n_Bu sorguyu calistirmak icin **2. islemi** kullanabilirsiniz._');
  }

  return kisalt(parcalar.join('\n'), WEBEX_LIMIT);
}

function kisalt(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 60)}\n\n_… cevap uzun oldugu icin kisaltildi._`;
}

module.exports = { askDbQuestion };
