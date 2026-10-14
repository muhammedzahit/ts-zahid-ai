'use strict';

// 5. islem: Branch kod incelemesi (yerel yapay zeka).
//
// Akis:
//   1. LIQUIBASE_SOURCE_REPO calisma kopyasinda istenen branch fetch edilir
//      (checkout YAPILMAZ — 6. islemin kullandigi prod checkout'u bozulmasin).
//   2. origin/<branch> uzerinde, mesajinda talep anahtari (ör. APTY-123) gecen
//      commit'ler bulunur, her birinin patch'i toplanir.
//   3. Diff, yerel calisan OpenAI uyumlu bir modele (/chat/completions)
//      verilir. Model, salt-okuma araclariyla (lib/llmAjan.js dongusu) branch'in
//      kodunu ve STAGING veritabanini (lib/stagingOku.js) arastirabilir; baglam
//      dolunca konusma sikistirilir (compact).
//   4. Puanli inceleme SHARED_FOLDER'a rapor olarak yazilir, Webex'e ozeti gider.
//
// Model yerel calisir; kod OpenAI, Anthropic vb. sirketlere GITMEZ.

const fs = require('fs');
const path = require('path');
const { calistir, SOURCE_REPO } = require('./liquibaseRun');
const { ajanCalistir, dusunceyiTemizle } = require('./llmAjan');
const { stagingAyarlari, stagingSorgu, kapaliMi } = require('./stagingOku');

const REMOTE = process.env.KOD_REVIEW_REMOTE || 'origin';
/**
 * Sayisal sinir okur. Bos → varsayilan; 0, negatif, "sinirsiz" ya da cok buyuk
 * (>= 1e9, ör. 2147483647) → sinirsiz (Infinity). Gecersiz deger → varsayilan.
 */
function sinirOku(deger, varsayilan) {
  const s = String(deger === undefined ? '' : deger).trim().toLowerCase();
  if (!s) return varsayilan;
  if (s === 'sinirsiz' || s === 'sınırsız') return Infinity;
  const n = Number(s);
  if (!Number.isFinite(n)) return varsayilan;
  if (n <= 0 || n >= 1e9) return Infinity;
  return Math.floor(n);
}

const MAX_COMMIT = sinirOku(process.env.KOD_REVIEW_MAX_COMMIT, 30);
// ~300k karakter ≈ 75-100k token; modelin 262k baglaminda cevaba yer kalir.
// Sinirsiz yapilirsa buyuk branch'lerde model baglam siniri asilip hata verebilir.
const MAX_DIFF_CHARS = sinirOku(process.env.KOD_REVIEW_MAX_DIFF_CHARS, 300000);
const GIT_TIMEOUT_MS = 5 * 60 * 1000;

// Webex mesaj siniri ~7439 bayt; Turkce karakterler 2 bayt oldugu icin pay birakildi.
const WEBEX_PARCA_BAYT = 6000;
const WEBEX_MAKS_PARCA = 15;

const YEREL_AI_UYARISI =
  '🔒 **Bilgi:** Bu islem yerel (local) calisan bir yapay zeka modeliyle yurutulur. ' +
  'Kod ve veriler OpenAI, Anthropic (Claude), Google gibi yapay zeka sirketlerinin ' +
  'modellerine **gonderilmez**.';

// Ayarlar cagri aninda okunur (testlerde env degistirilebilsin).
function llmAyarlari(env = process.env) {
  return {
    baseURL: (env.LLM_BASE_URL || '').trim(),
    apiKey: (env.LLM_API_KEY || '').trim(),
    model: (env.LLM_MODEL || '').trim() || 'strata',
    // Bos = "high". "-" yazilirsa reasoning_effort hic gonderilmez (desteklemeyen sunucular icin).
    reasoning: (() => {
      const r = (env.LLM_REASONING_EFFORT || '').trim() || 'high';
      return r === '-' ? '' : r;
    })(),
    maxTokens: Number(env.LLM_MAX_TOKENS) || 49152,
    timeoutMs: Number(env.LLM_TIMEOUT_MS) || 30 * 60 * 1000,
    baglamPenceresi: Number(env.LLM_CONTEXT_WINDOW) || 262144,
    // Ajan dongusu sinirlari; sinira gelince araclar kapatilip nihai inceleme istenir.
    maxAdim: sinirOku(env.KOD_REVIEW_MAX_ADIM, 40),
    toplamSureMs: sinirOku(env.KOD_REVIEW_TOPLAM_SURE_MS, 60 * 60 * 1000),
    araclarKapali: kapaliMi(env.KOD_REVIEW_ARACLAR),
  };
}

// Git ref adi kurallarinin guvenli alt kumesi: secenek gibi okunamaz ("-" ile
// baslamaz), ".." icermez, bosluk/ozel karakter yok.
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}$/;
const TALEP_RE = /[A-Za-z][A-Za-z0-9]+-\d+/;

/**
 * Kullanici girdisinden branch adini ve commit mesajlarinda aranacak metni cikarir.
 * "feature/APTY-123" → branch aynen, aranan "APTY-123".
 * @returns {{branch: string, aranan: string} | {hata: string}}
 */
function branchCoz(girdi) {
  const branch = (girdi || '').trim().split(/\s+/)[0] || '';
  if (!branch) return { hata: 'bos' };
  if (!BRANCH_RE.test(branch) || branch.endsWith('/') || branch.endsWith('.lock')) {
    return { hata: `Gecersiz branch adi: \`${branch.slice(0, 80)}\`` };
  }
  const talep = branch.match(TALEP_RE);
  return { branch, aranan: talep ? talep[0].toUpperCase() : branch };
}

const AYRAC = '\x1f';

/** `git log --format=%H%x1f%h%x1f%an%x1f%ad%x1f%s` ciktisini ayristirir. */
function logAyristir(cikti) {
  return (cikti || '')
    .split(/\r?\n/)
    .filter((l) => l.includes(AYRAC))
    .map((l) => {
      const [sha, kisa, yazar, tarih, ...mesaj] = l.split(AYRAC);
      return { sha, kisa, yazar, tarih, mesaj: mesaj.join(AYRAC) };
    });
}

/**
 * Uzun metni Webex sinirina sigacak parcalara boler. Satir sinirindan boler;
 * acik kalan ``` blogunu parcanin sonunda kapatip sonrakinde yeniden acar.
 */
function parcala(metin, limitBayt = WEBEX_PARCA_BAYT) {
  const bayt = (s) => Buffer.byteLength(s, 'utf8');
  // Kapanis/acilis ``` satirlari icin pay.
  const sinir = limitBayt - 16;

  // Tek basina siniri asan satirlar once karakter bazinda bolunur.
  const satirlar = [];
  for (const satir of (metin || '').split('\n')) {
    if (bayt(satir) <= sinir) {
      satirlar.push(satir);
      continue;
    }
    let parca = '';
    let parcaBayt = 0;
    for (const ch of satir) {
      const b = bayt(ch);
      if (parcaBayt + b > sinir) {
        satirlar.push(parca);
        parca = '';
        parcaBayt = 0;
      }
      parca += ch;
      parcaBayt += b;
    }
    if (parca) satirlar.push(parca);
  }

  const parcalar = [];
  let mevcut = [];
  let mevcutBayt = 0;
  let blokta = false;

  for (const satir of satirlar) {
    const b = bayt(satir) + 1;
    if (mevcut.length && mevcutBayt + b > sinir) {
      // Acik kod blogu parca sonunda kapatilir, sonraki parcada yeniden acilir.
      parcalar.push(mevcut.join('\n') + (blokta ? '\n```' : ''));
      mevcut = blokta ? ['```'] : [];
      mevcutBayt = blokta ? 4 : 0;
    }
    mevcut.push(satir);
    mevcutBayt += b;
    if (satir.trimStart().startsWith('```')) blokta = !blokta;
  }
  const son = mevcut.join('\n');
  if (son.trim() && son !== '```') parcalar.push(son);
  return parcalar;
}

function git(...argumanlar) {
  return calistir('git', ['-C', SOURCE_REPO, '-c', 'core.quotepath=false', ...argumanlar], {
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * Branch'i fetch eder, talep commit'lerini ve patch'lerini toplar.
 * Calisma kopyasina (checkout/working tree) dokunmaz.
 */
async function commitleriTopla(branch, aranan) {
  const ref = `${REMOTE}/${branch}`;
  const fetch = await git('fetch', '--no-tags', REMOTE, `+refs/heads/${branch}:refs/remotes/${ref}`);
  if (fetch.code !== 0) {
    throw new Error(
      `\`${branch}\` branch'i cekilemedi (${REMOTE}'ta yok olabilir).\n` +
        `\`\`\`\n${(fetch.stderr || fetch.stdout).trim().slice(0, 600)}\n\`\`\``
    );
  }

  const log = await git(
    'log', ref, '--no-merges', '-i', '-F', `--grep=${aranan}`,
    `--format=%H${'%x1f'}%h${'%x1f'}%an${'%x1f'}%ad${'%x1f'}%s`, '--date=short',
    // Sinirsizsa -n verilmez (Windows'ta git -n'i 32 bit tam sayi okur).
    ...(Number.isFinite(MAX_COMMIT) ? ['-n', String(MAX_COMMIT + 1)] : [])
  );
  if (log.code !== 0) {
    throw new Error(`git log basarisiz:\n\`\`\`\n${(log.stderr || log.stdout).trim().slice(0, 600)}\n\`\`\``);
  }

  let commitler = logAyristir(log.stdout);
  const fazla = commitler.length > MAX_COMMIT;
  // git log en yeniden eskiye verir; inceleme kronolojik sirayla okunsun.
  commitler = commitler.slice(0, MAX_COMMIT).reverse();

  let diff = '';
  let kirpildi = false;
  for (const c of commitler) {
    const show = await git('show', '--no-color', '--stat', '--patch', '--format=medium', '--date=short', c.sha);
    if (show.code !== 0) {
      throw new Error(`\`${c.kisa}\` commit'i okunamadi:\n${(show.stderr || '').trim().slice(0, 400)}`);
    }
    // Commit basligi + mesaj + degisen dosya ozeti (patch'ten once gelen kisim);
    // buyuk diff modunda modele yalnizca bu verilir.
    const cikti = show.stdout.trim();
    const patchBasi = cikti.indexOf('\ndiff --git ');
    c.ozet = (patchBasi >= 0 ? cikti.slice(0, patchBasi) : cikti).trim();

    if (kirpildi) continue;
    const parca = `${cikti}\n\n`;
    if (diff.length + parca.length > MAX_DIFF_CHARS) {
      diff += parca.slice(0, Math.max(0, MAX_DIFF_CHARS - diff.length));
      diff += '\n[... diff boyut siniri nedeniyle burada kesildi; kalani commit_diff araciyla okunabilir ...]\n';
      kirpildi = true;
      continue;
    }
    diff += parca;
  }

  return { ref, commitler, diff, kirpildi, fazla };
}

const SISTEM_TEMEL = [
  'Sen deneyimli bir kidemli yazilim muhendisisin ve kod incelemesi (code review) yapiyorsun.',
  'Sana bir Jira talebinin branch\'indeki commit\'lerin diff\'i verilecek.',
  'Gorevin: hatalari, mantik yanlislarini, guvenlik aciklarini, performans sorunlarini,',
  'eksik hata yonetimini, veri butunlugu risklerini ve bakimi zorlastiracak noktalari bulmak.',
  '',
  'Kurallar:',
  '- Yalnizca diff\'te gordugun degisikliklere yorum yap. Gormedigin kod hakkinda varsayimda',
  '  bulunuyorsan bunu acikca belirt.',
  '- Her bulgu icin: dosya (mumkunse metot/satir), sorunun ne oldugu, neden onemli oldugu ve',
  '  somut duzeltme onerisi.',
  '- Bulgulari onem sirasina gore ver ve HER bulgunun basina onem emojisini koy:',
  '  🔴 Kritik, 🟠 Onemli, 🟡 Kucuk/oneri. Bu uc emojiyi bulgu satirlari disinda (baslik,',
  '  ozet, degerlendirme) KULLANMA; bulgular bu emojilerle sayiliyor.',
  '- Sorun yoksa uydurma; "belirgin bir sorun bulunamadi" de.',
  '- Bicim/stil yorumlarini en sona ve kisa yaz.',
  '- Cevabi Turkce, Webex\'te okunacak Markdown olarak yaz: basliklar icin **kalin** kullan,',
  '  # basligi ve tablo KULLANMA. Kod ornekleri ``` blogunda olsun.',
  '',
  '',
  'Puanlama: degisikligin kalitesini 100 uzerinden puanla ve cevabin ILK SATIRINA tam olarak',
  '"PUAN: <0-100 arasi tam sayi>/100" yaz (ör. "PUAN: 78/100"), baska hicbir sey ekleme.',
  '- 90-100: belirgin sorun yok, yalnizca kucuk oneriler',
  '- 70-89: kucuk/orta sorunlar var, merge oncesi duzeltilmesi iyi olur',
  '- 50-69: onemli sorunlar var, duzeltilmeden merge edilmemeli',
  '- 0-49: kritik hata/guvenlik/veri kaybi riski var',
  'Puan bulgularla tutarli olsun: 🔴 Kritik bulgu varsa puan 50\'nin altinda olmali.',
  '',
  'Yapi: ilk satir PUAN, sonra **Ozet** (2-4 cumle: degisiklik ne yapiyor), **Bulgular**,',
  '**Genel Degerlendirme** (puanin gerekcesi dahil).',
].join('\n');

function aracKurallari(stagingVar) {
  return [
    '',
    'Araclar (HEPSI YALNIZCA OKUR, hicbir seyi degistirmez):',
    '- dosya_listele / dosya_oku / kod_ara: branch\'in son halindeki kodu okur. Degisen kodun',
    '  cagrildigi/kullanildigi yerleri, ilgili sinif ve metotlari gormek icin kullan.',
    '- commit_diff: incelenen commit\'lerden birinin patch\'ini sayfa sayfa okur.',
    ...(stagingVar
      ? [
          '- staging_sorgu: STAGING veritabaninda TEK bir SELECT calistirir (en fazla 50 satir).',
          '  Veritabani YALNIZCA OKUNABILIR: INSERT/UPDATE/DELETE/DDL ve yan etkili fonksiyonlar',
          '  reddedilir, deneme. Tablo/kolon yapisi icin information_schema\'yi sorgulayabilirsin.',
          '  Verinin kodla uyumunu (kolon tipleri, NULL olabilen alanlar, mevcut kayitlar, enum',
          '  degerleri) dogrulamak icin kullan. Kisisel verileri (isim, e-posta, TC no, telefon)',
          '  cevabina KOPYALAMA; gerekiyorsa yalnizca sayi/ozet ver.',
        ]
      : []),
    '',
    'Arac kurallari: Once verilen diff\'i incele; emin olmadigin noktalari araclarla dogrula.',
    'Gereksiz arac cagrisi yapma. Arastirman bitince arac CAGIRMADAN nihai incelemeyi yaz.',
    'Araclarla dogruladigin bulgularda bunu belirt (ör. "staging\'de 12 kayitta alan NULL").',
  ].join('\n');
}

/** Sistem mesaji; araclar varsa arac kurallari eklenir. */
function sistemMesaji({ araclarVar = false, stagingVar = false } = {}) {
  return araclarVar ? `${SISTEM_TEMEL}\n${aracKurallari(stagingVar)}` : SISTEM_TEMEL;
}

/**
 * Cevabin basindaki "PUAN: 78/100" satirini okur ve metinden ayirir.
 * @returns {{puan: number|null, govde: string}}
 */
function puanAyristir(metin) {
  const m = (metin || '').match(/^\s*\**\s*PUAN\s*\**\s*:\s*\**\s*(\d{1,3})\s*\/\s*100\**[^\n]*\n?/im);
  if (!m) return { puan: null, govde: (metin || '').trim() };
  const puan = Math.min(100, Math.max(0, Number(m[1])));
  return { puan, govde: (metin.slice(0, m.index) + metin.slice(m.index + m[0].length)).trim() };
}

function puanEtiketi(puan) {
  if (puan === null || puan === undefined) return '⚪ Puan verilmedi';
  const renk = puan >= 85 ? '🟢' : puan >= 60 ? '🟡' : '🔴';
  return `${renk} **${puan}/100**`;
}

/** **Ozet** bolumunu (bir sonraki **kalin** basliga kadar) cikarir; yoksa bastan kirpar. */
function ozetCikar(govde, sinir = 1200) {
  const m = (govde || '').match(/\*\*\s*[OÖ]zet\s*\*\*:?\s*([\s\S]*?)(?=\n\s*\*\*[^*\n]+\*\*\s*:?\s*\n|$)/i);
  const ozet = (m ? m[1] : govde || '').trim();
  return ozet.length > sinir ? `${ozet.slice(0, sinir).trimEnd()}…` : ozet;
}

/** Bulgu sayilari (onem emojilerine gore). */
function bulguSay(govde) {
  const say = (e) => ((govde || '').match(new RegExp(e, 'gu')) || []).length;
  return { kritik: say('🔴'), onemli: say('🟠'), kucuk: say('🟡') };
}

/** Diff, baglam penceresinin yarisindan buyukse modele verilmez (commit_diff ile okunur). */
function buyukDiffMi(diff, baglamPenceresi) {
  return Math.ceil((diff || '').length / 3) > baglamPenceresi * 0.5;
}

function kullaniciMesaji({ branch, commitler, diff, kirpildi, fazla, buyukMod = false, araclarVar = false }) {
  const liste = commitler.map((c) => `- ${c.kisa} ${c.tarih} ${c.yazar}: ${c.mesaj}`).join('\n');
  const notlar = [
    fazla ? `Not: yalnizca son ${commitler.length} commit verildi, daha eskileri dahil degil.` : '',
    kirpildi && !buyukMod
      ? araclarVar
        ? 'Not: diff boyut siniri nedeniyle sonda kesildi; kalan commit\'leri commit_diff araciyla okuyabilirsin.'
        : 'Not: diff boyut siniri nedeniyle sonda kesildi; gormedigin kisimlar hakkinda yorum yapma.'
      : '',
  ].filter(Boolean).join('\n');
  const basi =
    `Branch: ${branch}\n` +
    `Incelenecek commit'ler (${commitler.length}, eskiden yeniye):\n${liste}\n` +
    (notlar ? `${notlar}\n` : '');

  if (buyukMod) {
    const ozetler = commitler.map((c) => c.ozet || `commit ${c.sha}`).join('\n\n');
    return (
      basi +
      `\nDiff tek mesaja sigmayacak kadar buyuk (~${diff.length} karakter). Asagida her commit'in ` +
      'basligi ve degisen dosya ozeti var. Patch\'leri commit_diff araciyla (gerekirse sayfa sayfa) ' +
      'oku; tum commit\'leri incelemeden nihai cevabi yazma.\n\n' +
      `\`\`\`\n${ozetler}\n\`\`\``
    );
  }
  return `${basi}\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``;
}

// --- Salt-okuma araclari --------------------------------------------------

const DOSYA_OKU_MAKS = 40000;
const COMMIT_DIFF_SAYFA = 50000;

function fonksiyon(ad, aciklama, ozellikler, zorunlu = []) {
  return {
    type: 'function',
    function: {
      name: ad,
      description: aciklama,
      parameters: { type: 'object', properties: ozellikler, required: zorunlu },
    },
  };
}

function yolDogrula(yol, bosOlabilir = false) {
  const s = String(yol === undefined || yol === null ? '' : yol).trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!s && !bosOlabilir) throw new Error('yol bos olamaz');
  if (s.length > 500 || s.includes('\0')) throw new Error('gecersiz yol');
  return s;
}

function tamSayi(deger, varsayilan, min, max) {
  const n = Math.floor(Number(deger));
  if (!Number.isFinite(n)) return varsayilan;
  return Math.min(max, Math.max(min, n));
}

/**
 * Modelin kullanacagi salt-okuma araclari. Hepsi `ref` (origin/<branch>) uzerinden
 * calisir; calisma kopyasina ve veritabanina yazmaz.
 */
function araclariOlustur({ ref, commitler, staging }) {
  const araclar = [
    {
      tanim: fonksiyon(
        'dosya_listele',
        'Branch\'in son halindeki dosyalari listeler (yinelemeli). Klasor verilmezse tum depo.',
        { yol: { type: 'string', description: 'Klasor yolu, ör. service/src/main/java (bos = depo koku)' } }
      ),
      calistir: async ({ yol }) => {
        const y = yolDogrula(yol, true);
        const r = await git('ls-tree', '-r', '--name-only', ref, ...(y ? ['--', y] : []));
        if (r.code !== 0) throw new Error((r.stderr || 'listelenemedi').trim());
        const satirlar = r.stdout.split('\n').filter(Boolean);
        if (!satirlar.length) return 'Bu yolda dosya yok.';
        const goster = satirlar.slice(0, 500);
        return goster.join('\n') + (satirlar.length > 500 ? `\n(${satirlar.length} dosyanin ilk 500'u; klasoru daraltin)` : '');
      },
    },
    {
      tanim: fonksiyon(
        'dosya_oku',
        'Branch\'in son halindeki bir dosyayi satir numaralariyla okur.',
        {
          yol: { type: 'string', description: 'Depo kokune gore dosya yolu' },
          baslangic: { type: 'integer', description: 'Ilk satir (varsayilan 1)' },
          satir_sayisi: { type: 'integer', description: 'Okunacak satir sayisi (varsayilan 400, en fazla 2000)' },
        },
        ['yol']
      ),
      calistir: async ({ yol, baslangic, satir_sayisi }) => {
        const y = yolDogrula(yol);
        const r = await git('show', `${ref}:${y}`);
        if (r.code !== 0) throw new Error(`dosya bulunamadi: ${y}`);
        const satirlar = r.stdout.split('\n');
        const bas = tamSayi(baslangic, 1, 1, Math.max(1, satirlar.length));
        const adet = tamSayi(satir_sayisi, 400, 1, 2000);
        let metin = '';
        let son = bas - 1;
        for (let i = bas - 1; i < Math.min(satirlar.length, bas - 1 + adet); i++) {
          const satir = `${i + 1}: ${satirlar[i]}\n`;
          if (metin.length + satir.length > DOSYA_OKU_MAKS) break;
          metin += satir;
          son = i + 1;
        }
        return `${metin}(satir ${bas}-${son} / toplam ${satirlar.length}` +
          (son < satirlar.length ? `; devami icin baslangic=${son + 1})` : ')');
      },
    },
    {
      tanim: fonksiyon(
        'kod_ara',
        'Branch\'in son halindeki kodda duz metin arar (git grep). Satir numarasiyla eslesmeleri dondurur.',
        {
          desen: { type: 'string', description: 'Aranacak duz metin (regex degil)' },
          yol: { type: 'string', description: 'Aramayi sinirlamak icin klasor/dosya (istege bagli)' },
          buyuk_kucuk_duyarsiz: { type: 'boolean', description: 'true ise buyuk/kucuk harf ayrimi yapilmaz' },
        },
        ['desen']
      ),
      calistir: async ({ desen, yol, buyuk_kucuk_duyarsiz }) => {
        const d = String(desen || '');
        if (!d.trim()) throw new Error('desen bos olamaz');
        if (d.length > 300) throw new Error('desen cok uzun');
        const y = yolDogrula(yol, true);
        const r = await git(
          'grep', '-n', '-I', '-F', ...(buyuk_kucuk_duyarsiz ? ['-i'] : []), '-e', d, ref, ...(y ? ['--', y] : [])
        );
        if (r.code === 1) return 'Eslesme yok.';
        if (r.code !== 0) throw new Error((r.stderr || 'arama basarisiz').trim());
        const satirlar = r.stdout.split('\n').filter(Boolean).map((s) => (s.startsWith(`${ref}:`) ? s.slice(ref.length + 1) : s));
        return satirlar.slice(0, 200).join('\n') +
          (satirlar.length > 200 ? `\n(${satirlar.length} eslesmenin ilk 200'u; yolu daraltin)` : '');
      },
    },
    {
      tanim: fonksiyon(
        'commit_diff',
        'Incelenen commit\'lerden birinin tam patch\'ini sayfa sayfa okur.',
        {
          sha: { type: 'string', description: 'Commit sha (kisa ya da uzun; yalnizca incelenen listedekiler)' },
          sayfa: { type: 'integer', description: 'Sayfa numarasi (varsayilan 1)' },
        },
        ['sha']
      ),
      calistir: async ({ sha, sayfa }) => {
        const s = String(sha || '').trim().toLowerCase();
        const c = s.length >= 4 && commitler.find((x) => x.sha.startsWith(s) || x.kisa === s);
        if (!c) throw new Error('bu commit incelenen listede degil');
        const r = await git('show', '--no-color', '--stat', '--patch', '--format=medium', '--date=short', c.sha);
        if (r.code !== 0) throw new Error('commit okunamadi');
        const toplam = Math.max(1, Math.ceil(r.stdout.length / COMMIT_DIFF_SAYFA));
        const p = tamSayi(sayfa, 1, 1, toplam);
        const parca = r.stdout.slice((p - 1) * COMMIT_DIFF_SAYFA, p * COMMIT_DIFF_SAYFA);
        return `[${c.kisa} · sayfa ${p}/${toplam}]\n${parca}`;
      },
    },
  ];

  if (staging) {
    araclar.push({
      tanim: fonksiyon(
        'staging_sorgu',
        'STAGING veritabaninda tek bir SELECT sorgusu calistirir (YALNIZCA OKUMA, en fazla 50 satir).',
        { sql: { type: 'string', description: 'Tek bir SELECT ya da WITH ... SELECT sorgusu' } },
        ['sql']
      ),
      calistir: async ({ sql }) => stagingSorgu(String(sql || ''), staging),
    });
  }
  return araclar;
}

/**
 * Incelemeyi yerel modele yaptirir. Araclar aciksa ajan dongusu (salt-okuma
 * araclari + compact), degilse tek cagri.
 * @param {object} girdi  commitleriTopla ciktisi + branch
 * @param {object} [env]
 * @param {{staging?: object|null, olay?: Function}} [secenek]
 */
async function llmIncele(girdi, env = process.env, secenek = {}) {
  const ayar = llmAyarlari(env);
  if (!ayar.baseURL) {
    throw new Error('`LLM_BASE_URL` tanimli degil — .env\'e yerel modelin adresini yazin (ör. http://sunucu:port/v1).');
  }

  const araclar = ayar.araclarKapali || !girdi.ref
    ? []
    : araclariOlustur({ ref: girdi.ref, commitler: girdi.commitler, staging: secenek.staging || null });
  const araclarVar = araclar.length > 0;
  const stagingVar = araclar.some((a) => a.tanim.function.name === 'staging_sorgu');
  const buyukMod = araclarVar && buyukDiffMi(girdi.diff, ayar.baglamPenceresi);

  // Sunucu araclari reddederse diff dogrudan verilir; baglama sigsin diye pencerenin
  // yarisina gore kesilir.
  const aracsizDiffMaks = Math.floor(ayar.baglamPenceresi * 0.5 * 3);
  const aracsizGirdi = girdi.diff.length > aracsizDiffMaks
    ? { ...girdi, diff: `${girdi.diff.slice(0, aracsizDiffMaks)}\n[... baglam siniri nedeniyle kesildi ...]`, kirpildi: true }
    : girdi;

  const sonuc = await ajanCalistir({
    ayar,
    sistem: sistemMesaji({ araclarVar, stagingVar }),
    kullanici: kullaniciMesaji({ ...girdi, buyukMod, araclarVar }),
    aracsizKullanici: araclarVar ? kullaniciMesaji({ ...aracsizGirdi, buyukMod: false, araclarVar: false }) : undefined,
    araclar,
    maxAdim: ayar.maxAdim,
    baglamPenceresi: ayar.baglamPenceresi,
    toplamSureMs: ayar.toplamSureMs,
    olay: secenek.olay,
  });
  return { ...sonuc, buyukMod, stagingVar };
}

/** Arac kullanim istatistikleri (Webex satiri ve rapor icin). */
function aracIstatistik(aracKayitlari = []) {
  const say = (ad) => aracKayitlari.filter((k) => k.ad === ad).length;
  return {
    dosya: say('dosya_oku'),
    arama: say('kod_ara') + say('dosya_listele'),
    diff: say('commit_diff'),
    staging: say('staging_sorgu'),
    hata: aracKayitlari.filter((k) => k.hata).length,
  };
}

/** Webex'e basilacak tek satirlik arac ozeti. */
function aracOzeti(sonuc) {
  if (sonuc.aracsiz) return '🔧 Araclar kullanilmadi (tek seferlik inceleme).';
  const i = aracIstatistik(sonuc.aracKayitlari);
  const parcalar = [
    `${sonuc.adim} adim`,
    `${i.dosya} dosya okuma`,
    `${i.arama} arama`,
    i.diff ? `${i.diff} commit diff` : '',
    sonuc.stagingVar ? `${i.staging} staging sorgusu` : 'staging erisimi yok',
    sonuc.sikistirma ? `${sonuc.sikistirma} sikistirma` : '',
  ].filter(Boolean);
  return `🔧 ${parcalar.join(' · ')}`;
}

/** Axios/ag hatasini Webex'e yazilabilir Turkce mesaja cevirir. */
function hataMesaji(err) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') {
    return `Yerel yapay zeka sunucusuna ulasilamadi (${err.code}). Sunucu acik mi, \`LLM_BASE_URL\` dogru mu?`;
  }
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
    return 'Yerel yapay zeka zaman asimina ugradi (`LLM_TIMEOUT_MS`).';
  }
  if (err.response) {
    const veri = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
    return `Yerel yapay zeka HTTP ${err.response.status} dondu:\n\`\`\`\n${(veri || '').slice(0, 500)}\n\`\`\``;
  }
  return err.message;
}

/** SHARED_FOLDER'a yazilacak ayrintili rapor (Markdown). */
function aracBolumu({ aracsiz, adim, sikistirma, aracKayitlari = [], buyukMod, stagingVar }) {
  if (aracsiz === undefined) return [];
  if (aracsiz) return ['', '## Arac kullanimi', '', 'Model araclari kullanmadi (tek seferlik inceleme).'];
  const i = aracIstatistik(aracKayitlari);
  const satirlar = [
    '',
    '## Arac kullanimi',
    '',
    `- ${adim} adim · ${sikistirma || 0} baglam sikistirma${buyukMod ? ' · buyuk diff modu (commit_diff ile okundu)' : ''}`,
    `- ${i.dosya} dosya okuma · ${i.arama} arama · ${i.diff} commit diff · ` +
      `${stagingVar ? `${i.staging} staging sorgusu (salt-okuma)` : 'staging erisimi yok'}` +
      (i.hata ? ` · ${i.hata} hatali cagri` : ''),
  ];
  const dosyalar = [...new Set(aracKayitlari.filter((k) => k.ad === 'dosya_oku' && k.argumanlar).map((k) => k.argumanlar.yol))];
  if (dosyalar.length) satirlar.push('', '**Okunan dosyalar**', '', ...dosyalar.map((d) => `- \`${d}\``));
  const sorgular = aracKayitlari.filter((k) => k.ad === 'staging_sorgu' && k.argumanlar);
  if (sorgular.length) {
    satirlar.push('', '**Calistirilan STAGING sorgulari** (salt-okuma)', '');
    sorgular.forEach((k, n) => {
      satirlar.push(`${n + 1}. ${k.hata ? `_reddedildi/hata: ${k.hata}_` : 'basarili'}`, '```sql', String(k.argumanlar.sql || '').trim(), '```');
    });
  }
  return satirlar;
}

function raporOlustur({ branch, ref, commitler, govde, puan, model, sureSn, kirpildi, fazla, yarim, ...arac }) {
  const tarih = new Date().toLocaleString('tr-TR');
  const liste = commitler.map((c) => `- \`${c.kisa}\` ${c.tarih} · ${c.yazar} · ${c.mesaj}`).join('\n');
  const notlar = [
    fazla ? `- Commit siniri asildi; yalnizca en yeni ${commitler.length} commit incelendi.` : '',
    kirpildi ? '- Diff boyut sinirinda kesildi; kalan kisim incelenmedi.' : '',
    yarim ? '- Model token sinirina takildi; inceleme yarim kalmis olabilir.' : '',
  ].filter(Boolean).join('\n');
  return [
    `# Kod Incelemesi — ${branch}`,
    '',
    `- **Puan:** ${puan === null ? 'verilmedi' : `${puan}/100`}`,
    `- **Branch:** \`${ref || branch}\``,
    `- **Model:** \`${model}\` (yerel) · ${sureSn} sn`,
    `- **Tarih:** ${tarih}`,
    '',
    `## Incelenen commit'ler (${commitler.length})`,
    '',
    liste,
    ...(notlar ? ['', '## Notlar', '', notlar] : []),
    ...aracBolumu(arac),
    '',
    '## Inceleme',
    '',
    govde,
    '',
  ].join('\n');
}

/** Tam incelemeyi SHARED_FOLDER'a .md olarak yazar (varsa). Hata olursa null. */
function dosyayaYaz(branch, icerik) {
  const klasor = process.env.SHARED_FOLDER;
  if (!klasor) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const ad = `kod_review_${branch.replace(/[^A-Za-z0-9._-]/g, '_')}_${ts}.md`;
    const tam = path.join(klasor, ad);
    fs.writeFileSync(tam, icerik, 'utf8');
    return tam;
  } catch (err) {
    console.error('Kod incelemesi dosyaya yazilamadi:', err.message);
    return null;
  }
}

let calisiyor = false;
let gitCalisiyor = false;

function mesgulMu() {
  return calisiyor;
}

// 6. islem ayni depoda git calistirdigi icin fetch sirasinda bunu kontrol eder.
function gitMesgulMu() {
  return gitCalisiyor;
}

/**
 * Uctan uca inceleme.
 * @param {{branch: string, aranan: string, commitlerBulundu?: Function}} p
 * @returns {Promise<{ok: false, mesaj: string} | {ok: true, ...}>}
 */
async function kodReviewYap({ branch, aranan, commitlerBulundu, olay }) {
  if (calisiyor) throw new Error('Zaten devam eden bir kod incelemesi var, bitmesini bekleyin.');
  calisiyor = true;
  try {
    let toplanan;
    gitCalisiyor = true;
    try {
      toplanan = await commitleriTopla(branch, aranan);
    } finally {
      gitCalisiyor = false;
    }

    if (toplanan.commitler.length === 0) {
      return {
        ok: false,
        mesaj: `\`${toplanan.ref}\` uzerinde mesajinda \`${aranan}\` gecen commit bulunamadi.`,
      };
    }

    if (commitlerBulundu) await commitlerBulundu(toplanan);

    const staging = stagingAyarlari();
    const sonuc = await llmIncele({ branch, ...toplanan }, process.env, { staging, olay });
    const { puan, govde } = puanAyristir(sonuc.metin);
    return { ok: true, ...toplanan, ...sonuc, puan, govde };
  } finally {
    calisiyor = false;
  }
}

module.exports = {
  kodReviewYap,
  llmIncele,
  commitleriTopla,
  araclariOlustur,
  sistemMesaji,
  buyukDiffMi,
  aracOzeti,
  aracIstatistik,
  branchCoz,
  logAyristir,
  dusunceyiTemizle,
  parcala,
  hataMesaji,
  puanAyristir,
  puanEtiketi,
  ozetCikar,
  bulguSay,
  raporOlustur,
  dosyayaYaz,
  llmAyarlari,
  sinirOku,
  kullaniciMesaji,
  mesgulMu,
  gitMesgulMu,
  YEREL_AI_UYARISI,
  WEBEX_MAKS_PARCA,
};
