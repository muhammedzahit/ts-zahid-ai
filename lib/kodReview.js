'use strict';

// 5. islem: Branch kod incelemesi (yerel yapay zeka).
//
// Akis:
//   1. LIQUIBASE_SOURCE_REPO calisma kopyasinda istenen branch fetch edilir
//      (checkout YAPILMAZ — 6. islemin kullandigi prod checkout'u bozulmasin).
//   2. origin/<branch> uzerinde, mesajinda talep anahtari (ör. APTY-123) gecen
//      commit'ler bulunur, her birinin patch'i toplanir.
//   3. Diff, yerel calisan OpenAI uyumlu bir modele (/chat/completions)
//      gonderilir; donen Turkce inceleme Webex'e parca parca basilir.
//
// Model yerel calisir; kod OpenAI, Anthropic vb. sirketlere GITMEZ.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { calistir, SOURCE_REPO } = require('./liquibaseRun');

const REMOTE = process.env.KOD_REVIEW_REMOTE || 'origin';
const MAX_COMMIT = Number(process.env.KOD_REVIEW_MAX_COMMIT) || 30;
// ~300k karakter ≈ 75-100k token; modelin 262k baglaminda cevaba yer kalir.
const MAX_DIFF_CHARS = Number(process.env.KOD_REVIEW_MAX_DIFF_CHARS) || 300000;
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

/** Modelin cevabindaki <think>...</think> blogunu atar. */
function dusunceyiTemizle(metin) {
  return (metin || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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
    '-n', String(MAX_COMMIT + 1)
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
    const parca = `${show.stdout.trim()}\n\n`;
    if (diff.length + parca.length > MAX_DIFF_CHARS) {
      diff += parca.slice(0, Math.max(0, MAX_DIFF_CHARS - diff.length));
      diff += '\n[... diff boyut siniri nedeniyle burada kesildi ...]\n';
      kirpildi = true;
      break;
    }
    diff += parca;
  }

  return { ref, commitler, diff, kirpildi, fazla };
}

const SISTEM_MESAJI = [
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

function kullaniciMesaji({ branch, commitler, diff, kirpildi, fazla }) {
  const liste = commitler.map((c) => `- ${c.kisa} ${c.tarih} ${c.yazar}: ${c.mesaj}`).join('\n');
  const notlar = [
    fazla ? `Not: yalnizca son ${commitler.length} commit verildi, daha eskileri dahil degil.` : '',
    kirpildi ? 'Not: diff boyut siniri nedeniyle sonda kesildi; gormedigin kisimlar hakkinda yorum yapma.' : '',
  ].filter(Boolean).join('\n');
  return (
    `Branch: ${branch}\n` +
    `Incelenecek commit'ler (${commitler.length}, eskiden yeniye):\n${liste}\n` +
    (notlar ? `${notlar}\n` : '') +
    `\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``
  );
}

/** Yerel modele /chat/completions istegi atar, inceleme metnini dondurur. */
async function llmIncele(girdi, env = process.env) {
  const ayar = llmAyarlari(env);
  if (!ayar.baseURL) {
    throw new Error('`LLM_BASE_URL` tanimli degil — .env\'e yerel modelin adresini yazin (ör. http://sunucu:port/v1).');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (ayar.apiKey) {
    headers.Authorization = /^bearer\s/i.test(ayar.apiKey) ? ayar.apiKey : `Bearer ${ayar.apiKey}`;
  }

  const govde = {
    model: ayar.model,
    messages: [
      { role: 'system', content: SISTEM_MESAJI },
      { role: 'user', content: kullaniciMesaji(girdi) },
    ],
    max_tokens: ayar.maxTokens,
    stream: false,
  };
  if (ayar.reasoning) govde.reasoning_effort = ayar.reasoning;

  const basladi = Date.now();
  const cevap = await axios.post(`${ayar.baseURL.replace(/\/+$/, '')}/chat/completions`, govde, {
    headers,
    timeout: ayar.timeoutMs,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const secim = (cevap.data && cevap.data.choices && cevap.data.choices[0]) || {};
  const metin = dusunceyiTemizle(secim.message && secim.message.content);
  if (!metin) {
    const neden = secim.finish_reason === 'length'
      ? 'model token sinirina takildi (LLM_MAX_TOKENS artirilabilir)'
      : `bos cevap (finish_reason: ${secim.finish_reason || 'yok'})`;
    throw new Error(`Model inceleme metni dondurmedi: ${neden}.`);
  }

  return {
    metin,
    model: cevap.data.model || ayar.model,
    sureSn: Math.round((Date.now() - basladi) / 1000),
    yarim: secim.finish_reason === 'length',
  };
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
function raporOlustur({ branch, ref, commitler, govde, puan, model, sureSn, kirpildi, fazla, yarim }) {
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
async function kodReviewYap({ branch, aranan, commitlerBulundu }) {
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

    const sonuc = await llmIncele({ branch, ...toplanan });
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
  kullaniciMesaji,
  mesgulMu,
  gitMesgulMu,
  YEREL_AI_UYARISI,
  WEBEX_MAKS_PARCA,
};
