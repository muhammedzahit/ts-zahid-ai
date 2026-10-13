'use strict';

// 7. islem — Jira talebi atama onerisi.
// Ayri bir Python projesini (jira-crawler) alt surec olarak calistirir; o proje
// 7500+ gecmis isin BM25 indeksinden en benzer isleri bulup sahiplerini onerir.
// Iki giris yolu var: talep anahtari (APTY-125305) ya da serbest metin
// ("ekspertiz kati rapor json") — ikincisi henuz talep acilmadan "bu isi kim
// alir?" diye bakmak icin.
// Sifir harici bagimlilik (child_process).

const { spawn } = require('child_process');

const CRAWLER_DIR =
  process.env.JIRA_CRAWLER_DIR ||
  'C:\\Users\\T008356\\Documents\\Projeler\\claude\\jira-crawler';
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';

// Yerelde yoksa talep Jira'dan cekilir; agi da hesaba katarak genis tutuldu.
const TIMEOUT_MS = 90_000;

// Jira anahtari: PROJE-12345. Kabuk enjeksiyonuna karsi da tek savunma bu.
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

// Tam rapor isteyen kelimeler; metin aramasindan da ayiklanmalari gerekiyor.
const FULL_RE = /^(full|tam|detay|hepsi)$/i;

// Serbest metin ust siniri. Kimse 200 karakterlik bir "anahtar kelime" yazmaz;
// bu sinir yanlislikla yapistirilan talep govdesini erken yakalar.
const MAX_METIN = 200;

// Ozet modda 5 kisi / 3 dayanak; full modda tum adaylar ve daha fazla dayanak.
//
// 3 -> 5 degisikligi olculdu (son 90 gunde guncellenen 896 is, yani bugun gelen
// talebi en iyi temsil eden havuz): dogru kisiyi ilk 3'te bulma %74.9, ilk 5'te
// %86.7. 12 kisilik ekipte 5 isim havuzu hala %58 daraltiyor ve arac otomatik
// atama icin degil ON ELEME icin konumlandirilmis.
const OZET = { topN: 5, similar: 3 };
const FULL = { topN: 12, similar: 8 };

// Webex tek mesaj siniri; full rapor uzayabiliyor.
const MAX_MESAJ = 7000;

/**
 * Kullanicinin yazdigi parametreden talep anahtarini / arama metnini ve modu
 * ayirir.
 * "APTY-123" -> ozet | "APTY-123 full" -> tam rapor |
 * "ekspertiz kati rapor json" -> serbest metin aramasi.
 *
 * Anahtar oncelikli: yazilanlarin arasinda anahtar goruntusunde bir kelime
 * varsa o kullanilir, cunku o zaman kullanici gercek bir talebi kastediyordur.
 * @returns {{key: string, metin: string, full: boolean}}
 */
function parametreyiCoz(rest) {
  const kelimeler = String(rest || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const full = kelimeler.some((k) => FULL_RE.test(k));
  const kalan = kelimeler.filter((k) => !FULL_RE.test(k));
  const key = kalan.find((k) => KEY_RE.test(k.toUpperCase())) || '';
  // Anahtar yoksa geri kalan ne varsa arama metnidir.
  return { key, metin: key ? '' : kalan.join(' '), full };
}

/** Serbest metni alt surece vermeden once sadelestirir. */
function temizleMetin(ham) {
  return String(ham || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verilen talep ya da serbest metin icin atama onerisi alir.
 * @param {string|{key?: string, metin?: string}} girdi Jira anahtari
 *   (or. APTY-125305), arama metni, ya da parametreyiCoz ciktisi
 * @param {boolean} full Tum adaylari ve daha fazla dayanagi getir
 * @returns {Promise<object>} crawler'in JSON ciktisi
 */
function oneriAl(girdi, full = false) {
  const istek = typeof girdi === 'string' ? parametreyiCoz(girdi) : girdi || {};
  const key = String(istek.key || '').trim().toUpperCase();
  const metin = temizleMetin(istek.metin);

  if (!key && !metin) {
    return Promise.reject(new Error('Talep anahtari ya da aranacak kelimeler gerekli.'));
  }
  if (key && !KEY_RE.test(key)) {
    return Promise.reject(new Error(`Gecersiz talep anahtari: \`${istek.key}\``));
  }
  if (!key && metin.length > MAX_METIN) {
    return Promise.reject(
      new Error(`Arama metni cok uzun (${metin.length} karakter, sinir ${MAX_METIN}).`)
    );
  }

  const mod = full ? FULL : OZET;
  // Metin alt surece argüman dizisiyle gidiyor (kabuk yok) — yorumlanmiyor.
  const args = [
    '-m', 'jira_crawler', 'suggest',
    ...(key ? [key] : ['--metin', metin]),
    '--top', String(mod.topN),
    '--similar', String(mod.similar),
    '--json',
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(PYTHON_BIN, args, { cwd: CRAWLER_DIR, windowsHide: true });
    } catch (err) {
      reject(new Error(`Python baslatilamadi (${PYTHON_BIN}): ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let bitti = false;

    const zamanAsimi = setTimeout(() => {
      if (bitti) return;
      bitti = true;
      child.kill();
      reject(new Error('Oneri servisi zaman asimina ugradi (90 sn).'));
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanAsimi);
      reject(
        err.code === 'ENOENT'
          ? new Error(
              `Python bulunamadi (\`${PYTHON_BIN}\`). .env'de PYTHON_BIN ile tam yol verin.`
            )
          : new Error(`Oneri servisi calistirilamadi: ${err.message}`)
      );
    });

    child.on('close', (code) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zamanAsimi);

      let veri = null;
      try {
        veri = JSON.parse(stdout.trim());
      } catch {
        // JSON gelmediyse asagida ham cikti ile hata uretilir.
      }

      // Talep bulunamadi gibi beklenen hatalar da JSON olarak doner.
      if (veri && veri.error) {
        reject(new Error(veri.error));
        return;
      }
      if (code !== 0 || !veri) {
        const detay = (stderr || stdout || '').trim().slice(0, 400);
        reject(new Error(`Oneri uretilemedi (cikis kodu ${code}).${detay ? '\n' + detay : ''}`));
        return;
      }
      resolve(veri);
    });
  });
}

function kisalt(metin, n) {
  const t = String(metin || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Guven etiketleri: crawler `confidence.label` olarak GUCLU/ORTA/ZAYIF doner.
// Sinyal = benzer islerin kac FARKLI kisiye dagildigi; Top-3 isabetiyle en
// guclu iliskili olcut bu cikti (<=5 kisi %95.4, 6-7 %83.7, 8+ %74.3).
const GUVEN_ETIKET = { GUCLU: 'GÜÇLÜ', ORTA: 'ORTA', ZAYIF: 'ZAYIF' };

// Indeks bu kadar gunden eskiyse uyari basilir. Bayatlama en buyuk operasyonel
// kaldirac: taze %77.6 -> 1-3 ay %60.8 -> 6+ ay %47.5.
const BAYAT_GUN = 7;

/** Oneri sonucunu Webex markdown'ina cevirir. */
function formatla(veri, full = false) {
  const satirlar = [];
  // Serbest metin sorgusunda ortada bir talep yok: baslik da, proje/tip/durum
  // satiri da anlamsiz. Onun yerine neyin arandigi yazilir.
  const sorgu = veri.query;
  if (sorgu) {
    satirlar.push(`**Arama:** "${sorgu.text}"`);
    if ((sorgu.ignored || []).length) {
      satirlar.push(
        `_Indekste karsiligi olmayan kelimeler hesaba katilmadi: ` +
          `${sorgu.ignored.join(', ')}_`
      );
    }
  } else {
    const baslik = veri.title ? ` — ${veri.title}` : '';
    // Anahtari koprule (crawler `url` alanini donduruyor).
    const anahtar = veri.url ? `[${veri.key}](${veri.url})` : veri.key;
    satirlar.push(`**${anahtar}**${baslik}`);
    satirlar.push(
      `Proje: ${veri.project || '?'} · Tip: ${veri.issue_type || '?'} · Durum: ${veri.status || '?'}`
    );
  }

  // Indeks bayatsa her sey suphelidir; en basta soylenmeli.
  const yas = veri.index_age;
  if (yas && yas.days > BAYAT_GUN) {
    satirlar.push(
      `⚠️ _Indeks ${yas.days} gun eski (son senkron ${String(yas.last_sync || '').slice(0, 10)}) — ` +
        `bu yasta olculen isabet ~%${yas.expected_top3_at_age}. ` +
        'Crawler tarafinda `update` calistirilmali._'
    );
  }

  // Aracin ne zaman guvenilir oldugunu soyleyen sinyal.
  const guven = veri.confidence;
  if (guven && guven.label) {
    satirlar.push(
      `Güven: **${GUVEN_ETIKET[guven.label] || guven.label}** — benzer isler ` +
        `${guven.neighbour_owners} farkli kisiye dagilmis ` +
        `(listede dogru kisi bulunma orani ~%${guven.expected_top3})`
    );
  }

  if (veri.found_locally && veri.current_assignee) {
    satirlar.push(
      `_Bu talep veri setinde zaten var (${veri.current_assignee} uzerinde) — tahmine katilmadi._`
    );
  }

  if (!veri.suggestions || veri.suggestions.length === 0) {
    satirlar.push('\nYeterli benzer is bulunamadi, tahmin uretilemedi.');
    if (sorgu) {
      satirlar.push(
        '_Daha fazla ya da daha ayirt edici kelime deneyin; cok kisa ' +
          '(3 harften az) ve cok yaygin kelimeler indekste tutulmuyor._'
      );
    }
    return satirlar.join('\n');
  }

  if (full) {
    satirlar.push(`_Tam rapor — oy alan ${veri.suggestions.length} aday, ` +
      `en yakin ${veri.neighbors} is uzerinden._`);
  }
  satirlar.push('');

  veri.suggestions.forEach((s, i) => {
    // Acik is sayisi SADECE BILGI: skora girmiyor (global ceza olculdu,
    // kazanc yok - gecmiste isi alan genelde yogun olan kisi).
    const yuk = Number.isFinite(s.open_issues) ? ` · ${s.open_issues} acik is` : '';
    satirlar.push(
      `**${i + 1}. ${s.isim || s.sicil}** (${s.sicil}) — **%${Math.round(s.percent)}**${yuk}`
    );
    // Metin modunda proje yok: "proje %0" yazmak bilgi degil gurultu.
    const proje = sorgu ? '' : `proje %${Math.round(s.project_affinity)} · `;
    satirlar.push(
      `   metin %${Math.round(s.text_score)} · ${proje}` +
        `${s.votes}/${veri.neighbors} benzer is`
    );
    if ((s.similar || []).length) {
      satirlar.push('   Benzer Isler:');
      // Baslik da yazilir: anahtar tek basina hangi is oldugunu anlatmiyor.
      for (const b of s.similar) {
        satirlar.push(`   • \`${b.key}\` ${b.score.toFixed(2)} — ${kisalt(b.title, full ? 70 : 50)}`);
      }
    }
    satirlar.push('');
  });

  // Olculmus kor nokta: vakalarin %12.1'inde talebi acan kisi dogru cevapti ama
  // model onu ilk 3'e koymadi. Model kuraldan IYI (%79.2 vs %61.6), o yuzden
  // kisa devre YOK - sadece uyari. Uyari verildiginde acan kisi ~%31 oraninda
  // dogru cevap oluyor (listede oldugunda ~%82).
  const acan = veri.reporter_in_team;
  if (acan && acan.sicil && !acan.in_suggestions) {
    satirlar.push(
      `⚠️ _Bu talebi **${acan.sicil}** acti ama yukaridaki listede yok — ` +
        `bu durumda acan kisi ~%${acan.self_assign_rate} oraninda dogru cevap oluyor. ` +
        'Onu da degerlendirin._'
    );
    satirlar.push('');
  }

  if (!full) {
    const tekrar = sorgu ? sorgu.text : veri.key;
    satirlar.push('_Tum adaylar ve daha fazla dayanak icin: `7 ' + tekrar + ' full`_');
  }
  // Metin modunda proje bilgisi yok: skor tamamen metin benzerligi, "proje
  // uzmanligi %0" satirlari hata degil. Olculen isabet rakamlari da talep
  // anahtariyla yapilan sorgular icin gecerli.
  if (sorgu) {
    satirlar.push(
      '_Serbest metinde skor yalnizca metin benzerligidir (proje uzmanligi ' +
        'hesaba katilmaz). Asagidaki isabet oranlari talep anahtariyla olculdu; ' +
        'burada sonuc yazdiginiz kelimelerin ayirt ediciligine bagli._'
    );
  }
  satirlar.push(
    '_Tahmin gecmis islere dayanir. Olculen isabet (son 90 gunde guncellenen ' +
      '896 is): ilk oneri %47.7, ilk ucte %74.9, ilk beste %86.7. ' +
      'Kisilerin o anki is yuku ve izin durumu SKORA KATILMAZ (acik is sayisi ' +
      'yalnizca bilgi olarak gosterilir)._'
  );

  const mesaj = satirlar.join('\n');
  if (mesaj.length <= MAX_MESAJ) return mesaj;
  return mesaj.slice(0, MAX_MESAJ - 60).replace(/\n[^\n]*$/, '') +
    '\n\n_… rapor Webex siniri icin kisaltildi._';
}

module.exports = { oneriAl, formatla, parametreyiCoz, temizleMetin, KEY_RE, MAX_METIN };
