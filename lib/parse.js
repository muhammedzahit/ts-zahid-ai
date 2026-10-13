'use strict';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Grup odalarinda mention, mesaj metnine botun gorunen adi olarak eklenir
 * (ör. "OSEM Bot islemler"). Metnin basindaki bot adini temizler.
 * Bot adi metnin ortasinda geciyorsa (ör. SQL icinde) dokunulmaz.
 */
function stripBotMention(text, botName) {
  const t = (text || '').trim();
  if (!botName) return t;

  const re = new RegExp('^' + escapeRegex(botName) + '\\s*', 'i');
  return t.replace(re, '').trim();
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Mention iceren Webex mesajlarinda `text` alani HTML'den turetilir ve
 * satir sonlari (shift+enter) kaybolur. Bu fonksiyon `html` alanindan
 * satir sonlarini koruyarak duz metin uretir.
 * Botun kendi mention'i tamamen silinir; baska kisilerin mention'lari
 * gorunen ad olarak birakilir.
 */
function htmlToText(html, botName) {
  let t = html || '';

  t = t.replace(/<spark-mention\b[^>]*>([\s\S]*?)<\/spark-mention>/gi, (match, inner) => {
    if (botName && inner.trim().toLowerCase() === botName.trim().toLowerCase()) {
      return '';
    }
    return inner;
  });

  // Blok/satir sonu taglari newline'a cevrilir.
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|blockquote|li|pre|h[1-6])>/gi, '\n');

  // Kalan tum taglar silinir (code, strong, em, ul, span...).
  t = t.replace(/<[^>]+>/g, '');

  t = decodeHtmlEntities(t);

  return t.trim();
}

/**
 * Gelen mesaji parse eder: ilk satirin ilk kelimesi komut, geri kalani parametre.
 * Parametre ayni satirda da ("3 1") alt satirda da ("3\n1") yazilabilir;
 * ikisi birden varsa alt satir kazanir (2. islemdeki cok satirli SQL bozulmasin).
 */
function parseInput(text) {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim();
  const newlineIndex = normalized.indexOf('\n');

  const firstLine = newlineIndex === -1 ? normalized : normalized.slice(0, newlineIndex);
  const restLines = newlineIndex === -1 ? '' : normalized.slice(newlineIndex + 1).trim();

  const spaceIndex = firstLine.search(/\s/);
  const command = (spaceIndex === -1 ? firstLine : firstLine.slice(0, spaceIndex)).trim();
  const inlineArg = spaceIndex === -1 ? '' : firstLine.slice(spaceIndex + 1).trim();

  return { command, rest: restLines || inlineArg };
}

// 3. islem (Argo takibi) kontrol araligi: varsayilan 3 dk, `3 <dakika>` ile degistirilir.
const MERGE_CHECK_DEFAULT_DK = 3;
const MERGE_CHECK_MIN_DK = 1;
const MERGE_CHECK_MAX_DK = 60;

/**
 * `3` komutunun yanindaki dakika parametresini okur. Gecersiz/bos ise
 * varsayilana doner; gecersizse ayrica kullaniciya gosterilecek uyari uretir.
 * `verildi` = kullanici gecerli bir deger belirtti mi (aktif takibin araligini
 * degistirmek gerekip gerekmedigini bundan anlariz).
 */
function parseMergeInterval(rest) {
  const raw = (rest || '').trim();
  if (!raw) return { dakika: MERGE_CHECK_DEFAULT_DK, uyari: null, verildi: false };

  const dakika = Number(raw.replace(',', '.'));
  if (!Number.isFinite(dakika) || dakika < MERGE_CHECK_MIN_DK || dakika > MERGE_CHECK_MAX_DK) {
    return {
      dakika: MERGE_CHECK_DEFAULT_DK,
      uyari:
        `⚠️ Gecersiz kontrol araligi: \`${raw}\` — ${MERGE_CHECK_MIN_DK}-${MERGE_CHECK_MAX_DK} arasi bir dakika ` +
        `degeri verin (ornek: \`3 1\`). Varsayilan ${MERGE_CHECK_DEFAULT_DK} dakika kullanilacak.`,
      verildi: false,
    };
  }

  return { dakika, uyari: null, verildi: true };
}

module.exports = {
  stripBotMention,
  parseInput,
  htmlToText,
  parseMergeInterval,
  MERGE_CHECK_DEFAULT_DK,
  MERGE_CHECK_MIN_DK,
  MERGE_CHECK_MAX_DK,
};
