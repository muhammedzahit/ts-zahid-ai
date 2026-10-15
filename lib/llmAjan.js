'use strict';

// Yerel, OpenAI uyumlu (/chat/completions) model icin arac kullanan ajan dongusu.
//
// - Model `tool_calls` dondukce araclar calistirilir, sonuclari `role: tool`
//   mesajlariyla geri verilir; arac cagrisi olmayan cevap nihai cevaptir.
// - Baglam sikistirma (compact): tahmini baglam doluluk orani esigi gecince,
//   sistem + ilk kullanici mesaji disindaki gecmis modele ozetletilir ve tek bir
//   ozet mesajiyla degistirilir.
// - Adim/sure siniri dolunca araclar kapatilip nihai cevap istenir.
// - Sunucu `tools` parametresini reddederse araçsiz (tek cagri) moda dusulur.

const axios = require('axios');

const ARAC_SONUC_MAKS = 60000; // karakter; tek arac sonucu bundan uzunsa kesilir

const SIKISTIRMA_ISTEGI = [
  'Baglam penceresi dolmak uzere; konusma sikistirilacak.',
  'Simdiye kadarki arastirmani, devam edebilmen icin gereken her seyi koruyarak OZETLE:',
  '1. Bulgu adaylari (dosya / metot / satir + neden sorunlu oldugu)',
  '2. Araclarla ogrendigin onemli bilgiler (dosya icerikleri, veritabani verileri) — yalnizca sonuca etki eden kisimlar',
  '3. Okudugun commit\'ler, dosyalar ve calistirdigin sorgular',
  '4. Henuz kontrol etmedigin noktalar',
  'Ham arac ciktilarini kopyalama. Nihai cevabi YAZMA, yalnizca bu ozeti yaz.',
].join('\n');

const DEVAM_MESAJI =
  'Yukaridaki ozet, baglam doldugu icin sikistirilan onceki arastirmandir. ' +
  'Kaldigin yerden devam et; gerekiyorsa araclari tekrar kullanabilirsin.';

const SON_ADIM_MESAJI =
  'Arac kullanim siniri doldu. Arac KULLANMADAN, elindeki bilgilerle nihai cevabi simdi yaz.';

/** Mesajlarin karakter uzunlugu (token tahmini icin). */
function mesajKarakter(mesajlar) {
  let n = 0;
  for (const m of mesajlar) {
    n += (m.content || '').length;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

/** Karakter → token tahmini (Turkce + kod icin temkinli: 3 karakter/token). */
function tokenTahmini(karakter) {
  return Math.ceil(karakter / 3);
}

function aracSonucunuKirp(metin) {
  const s = String(metin === undefined || metin === null ? '' : metin);
  if (s.length <= ARAC_SONUC_MAKS) return s;
  return `${s.slice(0, ARAC_SONUC_MAKS)}\n[... arac sonucu ${s.length} karakterdi, ilk ${ARAC_SONUC_MAKS} karakter gosterildi ...]`;
}

function dusunceyiTemizle(metin) {
  return (metin || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Sunucunun `tools` parametresini desteklemedigini gosteren hata mi? */
function aracDesteklenmiyorMu(err) {
  return !!(err.response && [400, 404, 422, 500, 501].includes(err.response.status));
}

function basliklar(ayar) {
  const headers = { 'Content-Type': 'application/json' };
  if (ayar.apiKey) {
    headers.Authorization = /^bearer\s/i.test(ayar.apiKey) ? ayar.apiKey : `Bearer ${ayar.apiKey}`;
  }
  return headers;
}

/** Ag/baglanti kaynakli hata mi (sunucu kapali, ulasilamiyor, zaman asimi, gecit hatasi)? */
function baglantiHatasiMi(err) {
  if (!err) return false;
  const kodlar = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'];
  if (kodlar.includes(err.code)) return true;
  if (err.response && [502, 503, 504].includes(err.response.status)) return true;
  return !err.response && /timeout|socket hang up/i.test(err.message || '');
}

/**
 * Model sunucusuna ulasilabiliyor mu? GET <baseURL>/models. Sunucudan herhangi bir
 * HTTP cevabi gelmesi (404 dahil) "acik" sayilir; yalnizca ag hatasi "kapali"dir.
 * @returns {Promise<{ok: boolean, hata?: string}>}
 */
async function erisimKontrol(ayar, timeoutMs = 10000) {
  try {
    await axios.get(`${ayar.baseURL.replace(/\/+$/, '')}/models`, { headers: basliklar(ayar), timeout: timeoutMs });
    return { ok: true };
  } catch (err) {
    if (err.response && !baglantiHatasiMi(err)) return { ok: true };
    return { ok: false, hata: err.code || err.message };
  }
}

function istemciOlustur(ayar) {
  const headers = basliklar(ayar);
  const url = `${ayar.baseURL.replace(/\/+$/, '')}/chat/completions`;
  return async (govde) => {
    const tam = { model: ayar.model, max_tokens: ayar.maxTokens, stream: false, ...govde };
    if (ayar.reasoning) tam.reasoning_effort = ayar.reasoning;
    const cevap = await axios.post(url, tam, {
      headers,
      timeout: ayar.timeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    const secim = (cevap.data && cevap.data.choices && cevap.data.choices[0]) || {};
    return { secim, mesaj: secim.message || {}, usage: cevap.data.usage || null, model: cevap.data.model };
  };
}

/**
 * Ajan dongusu.
 * @param {object} p
 * @param {object} p.ayar        llmAyarlari() ciktisi (baseURL, apiKey, model, reasoning, maxTokens, timeoutMs)
 * @param {string} p.sistem      sistem mesaji
 * @param {string} p.kullanici   ilk kullanici mesaji (gorev)
 * @param {string} [p.aracsizKullanici]  sunucu araclari reddedip tek cagriya dusulurse
 *                               gorev mesaji bununla degistirilir (ör. araclarla okunacak
 *                               icerigi dogrudan iceren surum)
 * @param {Array<{tanim: object, calistir: Function}>} p.araclar  OpenAI function tanimi + calistirici
 * @param {number} [p.maxAdim=40]
 * @param {number} [p.baglamPenceresi=262144]  token
 * @param {number} [p.sikistirmaOrani=0.75]
 * @param {number} [p.toplamSureMs=Infinity]   asilinca araclar kapatilip nihai cevap istenir
 * @param {Function} [p.olay]    (tur, veri) => void — ilerleme/log
 */
async function ajanCalistir({
  ayar,
  sistem,
  kullanici,
  aracsizKullanici,
  araclar = [],
  maxAdim = 40,
  baglamPenceresi = 262144,
  sikistirmaOrani = 0.75,
  toplamSureMs = Infinity,
  olay = () => {},
}) {
  const sohbet = istemciOlustur(ayar);
  const aracHaritasi = new Map(araclar.map((a) => [a.tanim.function.name, a]));
  const tanimlar = araclar.map((a) => a.tanim);

  const basladi = Date.now();
  let mesajlar = [
    { role: 'system', content: sistem },
    { role: 'user', content: kullanici },
  ];
  let aracsiz = araclar.length === 0;
  let sikistirma = 0;
  let adim = 0;
  let sonModel = ayar.model;
  let sonAdimIstendi = false;
  let bosCevapDenemesi = 0;
  const aracKayitlari = [];
  // Son cevaptaki gercek token sayisi + o andaki mesaj sayisi (sonrasi tahmin edilir).
  let bilinen = null;

  const baglamTahmini = () => {
    if (bilinen) return bilinen.token + tokenTahmini(mesajKarakter(mesajlar.slice(bilinen.mesajSayisi)));
    return tokenTahmini(mesajKarakter(mesajlar));
  };

  const sikistir = async () => {
    const gecmis = mesajlar.slice(2);
    const { mesaj, model } = await sohbet({
      messages: [...mesajlar, { role: 'user', content: SIKISTIRMA_ISTEGI }],
      // Gecmiste tool_calls oldugu icin tanimlar gonderilir ama kullanimi kapatilir.
      tools: tanimlar,
      tool_choice: 'none',
    });
    const ozet = dusunceyiTemizle(mesaj.content);
    if (!ozet) throw new Error('Baglam sikistirma basarisiz: model ozet dondurmedi.');
    sonModel = model || sonModel;
    mesajlar = [
      mesajlar[0],
      mesajlar[1],
      { role: 'assistant', content: `[Onceki arastirmanin ozeti]\n${ozet}` },
      { role: 'user', content: DEVAM_MESAJI },
    ];
    bilinen = null;
    sikistirma += 1;
    olay('sikistirma', { atilanMesaj: gecmis.length, ozetKarakter: ozet.length });
  };

  for (;;) {
    adim += 1;
    const sureDoldu = Date.now() - basladi > toplamSureMs;
    const sonAdim = !aracsiz && (adim > maxAdim || sureDoldu);

    if (sonAdim && !sonAdimIstendi) {
      mesajlar.push({ role: 'user', content: SON_ADIM_MESAJI });
      sonAdimIstendi = true;
      olay('son_adim', { adim, sureDoldu });
    }

    // Compact: yalnizca ozetlenecek arac sonucu varken (ilk iki mesaj korunur). Ozetten
    // sonra yeni arac sonucu gelmeden tekrar tetiklenmez; boylece dev bir ilk mesaj
    // sonsuz sikistirma dongusune sokmaz.
    const aracGecmisiVar = mesajlar.slice(2).some((m) => m.role === 'tool');
    if (!aracsiz && aracGecmisiVar && baglamTahmini() > baglamPenceresi * sikistirmaOrani) {
      await sikistir();
    }

    const govde = { messages: mesajlar };
    if (!aracsiz) {
      govde.tools = tanimlar;
      govde.tool_choice = sonAdim ? 'none' : 'auto';
    }

    let yanit;
    try {
      yanit = await sohbet(govde);
    } catch (err) {
      // Ilk istekte reddedildiyse sunucu muhtemelen arac desteklemiyor: araçsiz tekrar dene.
      if (!aracsiz && adim === 1 && aracDesteklenmiyorMu(err)) {
        aracsiz = true;
        if (aracsizKullanici) mesajlar[1] = { role: 'user', content: aracsizKullanici };
        olay('aracsiz_mod', { durum: err.response.status });
        adim = 0;
        continue;
      }
      throw err;
    }

    const { secim, mesaj, usage, model } = yanit;
    sonModel = model || sonModel;
    const cagrilar = Array.isArray(mesaj.tool_calls) ? mesaj.tool_calls : [];

    if (cagrilar.length && !aracsiz && !sonAdim) {
      // Bazi yerel sunucular id dondurmuyor; eslesme icin uretilir.
      const normal = cagrilar.map((c, i) => ({
        id: c.id || `cagri_${adim}_${i}`,
        type: 'function',
        function: { name: (c.function && c.function.name) || '', arguments: (c.function && c.function.arguments) || '{}' },
      }));
      mesajlar.push({ role: 'assistant', content: mesaj.content || '', tool_calls: normal });
      if (usage && usage.prompt_tokens) {
        bilinen = { token: usage.prompt_tokens + (usage.completion_tokens || 0), mesajSayisi: mesajlar.length };
      }

      for (const c of normal) {
        const ad = c.function.name;
        const kayit = { adim, ad, argumanlar: null, hata: null, karakter: 0 };
        let sonuc;
        try {
          kayit.argumanlar = JSON.parse(c.function.arguments || '{}');
        } catch (_) {
          kayit.hata = 'arguman JSON degil';
        }
        const arac = aracHaritasi.get(ad);
        if (kayit.hata) {
          sonuc = `HATA: argumanlar gecerli JSON degil: ${String(c.function.arguments).slice(0, 200)}`;
        } else if (!arac) {
          kayit.hata = 'bilinmeyen arac';
          sonuc = `HATA: "${ad}" adinda arac yok. Mevcut araclar: ${[...aracHaritasi.keys()].join(', ')}`;
        } else {
          try {
            sonuc = await arac.calistir(kayit.argumanlar || {});
          } catch (err) {
            kayit.hata = err.message;
            sonuc = `HATA: ${err.message}`;
          }
        }
        sonuc = aracSonucunuKirp(sonuc);
        kayit.karakter = sonuc.length;
        aracKayitlari.push(kayit);
        olay('arac', kayit);
        mesajlar.push({ role: 'tool', tool_call_id: c.id, content: sonuc });
      }
      continue;
    }

    const metin = dusunceyiTemizle(mesaj.content);
    if (!metin) {
      if (secim.finish_reason === 'length') {
        throw new Error('Model token sinirina takildi (LLM_MAX_TOKENS artirilabilir).');
      }
      // Bos cevap (ör. son adimda yine arac cagirmaya calisti): bir kez nihai cevap iste.
      if (bosCevapDenemesi < 1) {
        bosCevapDenemesi += 1;
        if (!sonAdimIstendi) {
          mesajlar.push({ role: 'user', content: SON_ADIM_MESAJI });
          sonAdimIstendi = true;
        }
        adim = Math.max(adim, maxAdim);
        continue;
      }
      throw new Error(`Model nihai cevap dondurmedi (finish_reason: ${secim.finish_reason || 'yok'}).`);
    }

    return {
      metin,
      model: sonModel,
      adim,
      sikistirma,
      aracKayitlari,
      aracsiz,
      yarim: secim.finish_reason === 'length',
      sureSn: Math.round((Date.now() - basladi) / 1000),
    };
  }
}

module.exports = {
  ajanCalistir,
  erisimKontrol,
  baglantiHatasiMi,
  mesajKarakter,
  tokenTahmini,
  aracSonucunuKirp,
  dusunceyiTemizle,
  aracDesteklenmiyorMu,
  SIKISTIRMA_ISTEGI,
  ARAC_SONUC_MAKS,
};
