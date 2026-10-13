'use strict';

// 6. islem: Liquibase calistirma.
//
// Akis:
//   1. backend-liquibase-2 calisma kopyasinda `prod` branch'ine gecilir + pull
//   2. service/.../db/changelog klasoru liquibase-spring projesine aynalanir
//   3. liquibase-spring/run.cmd <profil> <mod> calistirilir
//
// Calistirma isini Node degil, projenin kendi run.cmd'si yapar; boylece ayni
// komut elle de (IntelliJ/cmd) calistirilabilir ve davranis birebir ayni olur.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SOURCE_REPO =
  process.env.LIQUIBASE_SOURCE_REPO || 'C:\\Users\\T008356\\Documents\\Projeler\\backend-liquibase-2';
// liquibase-spring bu reponun icinde duruyor. Goreli yol repo kokune gore
// cozulur (pm2'nin cwd'sinden bagimsiz); mutlak yol verilirse aynen kullanilir.
const PROJECT_DIR = path.resolve(
  __dirname,
  '..',
  process.env.LIQUIBASE_PROJECT_DIR || 'liquibase-spring'
);
const SOURCE_BRANCH = process.env.LIQUIBASE_SOURCE_BRANCH || 'prod';

// Prod update'i yuzlerce changeset calistirabilir; genis tutuldu.
const RUN_TIMEOUT_MS = Number(process.env.LIQUIBASE_TIMEOUT_MS) || 30 * 60 * 1000;
const GIT_TIMEOUT_MS = Number(process.env.LIQUIBASE_GIT_TIMEOUT_MS) || 5 * 60 * 1000;

const CHANGELOG_SRC = path.join(SOURCE_REPO, 'service', 'src', 'main', 'resources', 'db', 'changelog');
const CHANGELOG_DST = path.join(PROJECT_DIR, 'src', 'main', 'resources', 'db', 'changelog');
const RUN_CMD = path.join(PROJECT_DIR, 'run.cmd');

/**
 * Bir komutu calistirir; stdout/stderr'i toplar. Kabuk kullanilmaz
 * (argumanlar dogrudan gecilir), .cmd dosyalari cmd.exe /c ile cagrilir.
 */
function calistir(komut, argumanlar, { cwd, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(komut, argumanlar, { cwd, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let zamanAsimi = false;

    const timer = setTimeout(() => {
      zamanAsimi = true;
      child.kill();
    }, timeout || RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`"${komut}" calistirilamadi: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (zamanAsimi) {
        reject(new Error(`"${komut}" zaman asimina ugradi (${Math.round((timeout || RUN_TIMEOUT_MS) / 60000)} dk).`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function git(...argumanlar) {
  return calistir('git', ['-C', SOURCE_REPO, ...argumanlar], { timeout: GIT_TIMEOUT_MS });
}

/**
 * backend-liquibase-2'yi prod branch'ine alip gunceller, sonra changelog
 * klasorunu liquibase-spring altina aynalar (silinenler dahil).
 *
 * Kullanicinin calisma kopyasi kullanildigi icin (baska branch'te veya
 * kaydedilmemis degisiklik varsa) checkout/pull basarisiz olabilir —
 * bu durumda ne yapilmasi gerektigi mesajda acikca soylenir.
 *
 * @returns {Promise<{oncekiBranch: string, oncekiCommit: string, commit: string, yeniCommitSayisi: number}>}
 */
async function changeloglariSenkronla() {
  if (!fs.existsSync(CHANGELOG_SRC)) {
    throw new Error(`Changelog klasoru bulunamadi: ${CHANGELOG_SRC}`);
  }

  const branchSonuc = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const oncekiBranch = branchSonuc.stdout.trim();

  if (oncekiBranch !== SOURCE_BRANCH) {
    const checkout = await git('checkout', SOURCE_BRANCH);
    if (checkout.code !== 0) {
      throw new Error(
        `backend-liquibase-2 deposu "${SOURCE_BRANCH}" branch'ine gecirilemedi ` +
          `(su an "${oncekiBranch}"). Kaydedilmemis degisiklikleriniz olabilir; ` +
          `commit/stash edip tekrar deneyin.\n${(checkout.stderr || checkout.stdout).trim()}`
      );
    }
  }

  const oncekiCommitSonuc = await git('rev-parse', '--short', 'HEAD');
  const oncekiCommit = oncekiCommitSonuc.stdout.trim();

  const pull = await git('pull', '--ff-only');
  if (pull.code !== 0) {
    throw new Error(
      `"${SOURCE_BRANCH}" branch'i guncellenemedi (git pull --ff-only basarisiz).\n` +
        `${(pull.stderr || pull.stdout).trim()}`
    );
  }

  const commitSonuc = await git('rev-parse', '--short', 'HEAD');
  const commit = commitSonuc.stdout.trim();

  let yeniCommitSayisi = 0;
  if (commit !== oncekiCommit) {
    const sayim = await git('rev-list', '--count', `${oncekiCommit}..${commit}`);
    yeniCommitSayisi = Number(sayim.stdout.trim()) || 0;
  }

  fs.mkdirSync(CHANGELOG_DST, { recursive: true });
  // /MIR: hedefi kaynagin aynasi yapar (silinen changelog'lar hedefte kalmaz).
  const kopya = await calistir(
    'robocopy',
    [CHANGELOG_SRC, CHANGELOG_DST, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'],
    { timeout: GIT_TIMEOUT_MS }
  );
  // Robocopy 0-7 arasi cikis kodlarini "basarili" sayar (8 ve uzeri gercek hata).
  if (kopya.code >= 8) {
    throw new Error(`Changelog kopyalama basarisiz (robocopy ${kopya.code}):\n${kopya.stdout.trim()}`);
  }

  return { oncekiBranch, oncekiCommit, commit, yeniCommitSayisi };
}

/**
 * run.cmd ciktisindaki "ANAHTAR: deger" satirlarini ayristirir.
 * Anahtarlar liquibase-spring/src/main/java/.../Ciktilar.java ile ayni olmali.
 */
function ciktiyiAyristir(stdout) {
  const sonuc = {
    basarili: false,
    profil: null,
    mod: null,
    url: null,
    sema: null,
    changelog: null,
    dropFirst: null,
    bekleyenAdet: null,
    bekleyenler: [],
    uygulananAdet: null,
    uygulananlar: [],
    basarisizChangeSet: null,
    sqlDosyasi: null,
    hataMesaji: null,
  };

  for (const satir of stdout.split(/\r?\n/)) {
    const s = satir.trim();
    if (s.startsWith('SONUC:')) sonuc.basarili = s.slice('SONUC:'.length).trim() === 'BASARILI';
    else if (s.startsWith('HATA_MESAJI:')) sonuc.hataMesaji = s.slice('HATA_MESAJI:'.length).trim();
    else if (s.startsWith('BEKLEYEN_ADET:')) sonuc.bekleyenAdet = Number(s.slice('BEKLEYEN_ADET:'.length).trim());
    else if (s.startsWith('BEKLEYEN:')) sonuc.bekleyenler.push(s.slice('BEKLEYEN:'.length).trim());
    else if (s.startsWith('UYGULANAN_ADET:')) sonuc.uygulananAdet = Number(s.slice('UYGULANAN_ADET:'.length).trim());
    else if (s.startsWith('UYGULANAN:')) sonuc.uygulananlar.push(s.slice('UYGULANAN:'.length).trim());
    else if (s.startsWith('BASARISIZ_CHANGESET:')) sonuc.basarisizChangeSet = s.slice('BASARISIZ_CHANGESET:'.length).trim();
    else if (s.startsWith('SQL_DOSYASI:')) sonuc.sqlDosyasi = s.slice('SQL_DOSYASI:'.length).trim();
    else if (s.startsWith('PROFIL:')) sonuc.profil = s.slice('PROFIL:'.length).trim();
    else if (s.startsWith('MOD:')) sonuc.mod = s.slice('MOD:'.length).trim();
    else if (s.startsWith('URL:')) sonuc.url = s.slice('URL:'.length).trim();
    else if (s.startsWith('SEMA:')) sonuc.sema = s.slice('SEMA:'.length).trim();
    else if (s.startsWith('CHANGELOG:')) sonuc.changelog = s.slice('CHANGELOG:'.length).trim();
    else if (s.startsWith('DROP_FIRST:')) sonuc.dropFirst = s.slice('DROP_FIRST:'.length).trim();
  }

  return sonuc;
}

/**
 * UYGULANAN_ADET satiri yoksa (eski derleme) log satirlarindan tahmin eder.
 * DIKKAT: bu loglar onizleme modunda da basiliyor, bu yuzden yalnizca
 * update modunda ve yedek olarak kullanilir.
 */
function uygulananSayisi(stdout) {
  const eslesme = stdout.match(/ChangeSet .+ ran successfully/g);
  return eslesme ? eslesme.length : 0;
}

// Ayni anda iki liquibase calismasin (ayni DB'ye paralel update / changelog
// klasorunun altindan kaymasi riski).
let calisiyor = false;

function mesgulMu() {
  return calisiyor;
}

/**
 * Liquibase'i calistirir.
 * @param {{profil: 'staging'|'prod', mod: 'preview'|'update'}} secenekler
 */
async function liquibaseCalistir({ profil, mod }) {
  if (!fs.existsSync(RUN_CMD)) {
    throw new Error(`run.cmd bulunamadi: ${RUN_CMD}`);
  }
  if (calisiyor) {
    throw new Error('Zaten calisan bir liquibase islemi var, bitmesini bekleyin.');
  }

  calisiyor = true;
  const basladi = Date.now();
  try {
    const komutYorumlayici = process.env.ComSpec || 'cmd.exe';
    const sonuc = await calistir(komutYorumlayici, ['/c', RUN_CMD, profil, mod], {
      cwd: PROJECT_DIR,
      timeout: RUN_TIMEOUT_MS,
    });

    const cikti = ciktiyiAyristir(sonuc.stdout);
    cikti.cikisKodu = sonuc.code;
    cikti.sureSn = Math.round((Date.now() - basladi) / 1000);
    // Adet dinleyiciden gelir; marker yoksa log satirlarindan tahmin edilir.
    cikti.uygulanan =
      cikti.uygulananAdet !== null
        ? cikti.uygulananAdet
        : mod === 'update'
          ? uygulananSayisi(sonuc.stdout)
          : 0;

    if (!cikti.basarili && !cikti.hataMesaji) {
      // Marker satiri hic basilamamis (ör. run.cmd erken cikti) — ham ciktidan
      // anlamli bir kuyruk ver.
      const kuyruk = (sonuc.stderr || sonuc.stdout || '').trim().split(/\r?\n/).slice(-8).join('\n');
      cikti.hataMesaji = kuyruk || `run.cmd ${sonuc.code} kodu ile cikti.`;
    }

    return cikti;
  } finally {
    calisiyor = false;
  }
}

module.exports = {
  changeloglariSenkronla,
  liquibaseCalistir,
  ciktiyiAyristir,
  uygulananSayisi,
  mesgulMu,
  SOURCE_REPO,
  PROJECT_DIR,
  SOURCE_BRANCH,
  CHANGELOG_SRC,
  CHANGELOG_DST,
  RUN_CMD,
};
