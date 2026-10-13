'use strict';

require('dotenv').config();

// Node 21+ globalThis.navigator'i yalnizca getter olarak tanimliyor; webex SDK 2.60.0
// yuklenirken global.navigator'a atama yapip TypeError ile cokuyor. Ozelligi
// yazilabilir hale getiriyoruz (Node 20'de ozellik yok, dokunulmaz).
const navTanim = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
if (navTanim && navTanim.get && navTanim.configurable) {
  Object.defineProperty(globalThis, 'navigator', {
    value: undefined,
    writable: true,
    configurable: true,
    enumerable: navTanim.enumerable,
  });
}

const Framework = require('webex-node-bot-framework');
const { changeTemporaryPassword } = require('./lib/tempPassword');
const { handleSelectQuery } = require('./lib/dbQuery');
const { stripBotMention, parseInput, htmlToText, parseMergeInterval } = require('./lib/parse');
const ArgoControl = require('./lib/mergeControl');
const { loadRoomPermissions, loadListenedOps, isAllowed } = require('./lib/permissions');
const { addNote, listNotes, clearNotes, formatNotes } = require('./lib/mergeNotes');
const {
  changeloglariSenkronla,
  liquibaseCalistir,
  mesgulMu: liquibaseMesgulMu,
} = require('./lib/liquibaseRun');
const kodReview = require('./lib/kodReview');

const config = {
  token: process.env.WEBEX_BOT_TOKEN,
  // webhookUrl verilmedigi icin framework websocket modunda calisir (public URL gerekmez).
  // messageFormat varsayilani 'text'; belirtilmezse **kalin** ve ``` bloklari
  // Webex'te ham metin olarak gider. SQL bloklarinin renklenmesi icin gerekli.
  messageFormat: 'markdown',
};

// Grup bazli yetkiler (.env: WEBEX_ROOM_ID_<GRUP> + WEBEX_ROOM_ID_<GRUP>_YETKILER).
// Burada tanimli olmayan oda/DM'lerden gelen mesajlar tamamen yoksayilir.
const ROOM_PERMS = loadRoomPermissions(process.env);

// Bu kopyanin (makinenin) dinledigi islemler (.env: DINLENEN_ISLEMLER="1,2,3").
// Bos = hepsi. Dinlenmeyen islem komutlari sessizce yoksayilir; o islemi baska
// bir makinedeki kopya cevaplar. Kopyalar arasi cakisma kontrol edilmez.
const LISTENED = loadListenedOps(process.env);

const framework = new Framework(config);

framework.start();

framework.on('initialized', () => {
  console.log('OSEM bot baslatildi ve dinlemede.');
  if (ROOM_PERMS.size === 0) {
    console.log('UYARI: env\'de WEBEX_ROOM_ID_<GRUP> tanimi yok — bot hicbir odayi dinlemeyecek.');
  }
  for (const perm of ROOM_PERMS.values()) {
    const yetkiler = perm.all ? 'all' : ([...perm.allowed].join(',') || '(yok)');
    console.log(`Grup yuklendi: ${perm.group} → yetkiler: ${yetkiler}`);
  }
  const dinlenen = LISTENED.all ? 'all' : ([...LISTENED.allowed].join(',') || '(yok)');
  console.log(`Bu kopyanin dinledigi islemler (DINLENEN_ISLEMLER): ${dinlenen}`);
});

const OPERATIONS = [
  {
    cmd: '1',
    menuText:
      '**1 — Kullanicinin sifresini 30 saniyeligine degistir**\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n1\nkullanici@ornek.com\n```',
  },
  {
    cmd: '2',
    menuText:
      '**2 — Prod DB\'de SELECT sorgusu calistir**\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n2\nSELECT * FROM tablo WHERE ...\n```',
  },
  {
    cmd: '3',
    menuText:
      '**3 — Argo Merge Durumu**\n' +
      'Kullanim: sadece `3` yazin. Merge devam ediyorsa bitene kadar 3 dakikada bir gruba bildirim atilir.\n' +
      'Farkli aralik icin yaninda dakika yazin (1-60): `3 1` → 1 dakikada bir kontrol.',
  },
  {
    cmd: '4',
    menuText:
      '**4 — Bir sonraki merge icin not birak**\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n4\nCache temizlensin\n```\n' +
      'Birakilan notlar 3. islem calistirildiginda gruba gosterilir ve listeden temizlenir.',
  },
  {
    cmd: '5',
    menuText:
      '**5 — Branch kod incelemesi (yerel yapay zeka)**\n' +
      'Branch adini verin; o branch\'teki talep commit\'leri (ör. `APTY-123 update`) yerel bir yapay zeka modeline incelettirilir.\n' +
      'Kullanim: `5 APTY-123`\n' +
      'Alt satira da yazilabilir:\n' +
      '```\n5\nAPTY-123\n```\n' +
      'Inceleme birkac dakika surebilir.\n' +
      kodReview.YEREL_AI_UYARISI,
  },
  {
    cmd: '6',
    menuText:
      '**6 — Liquibase calistir**\n' +
      'Changelog\'lar her calistirmada `backend-liquibase-2` deposunun `prod` branch\'inden guncellenir.\n' +
      'Kullanim (araya yeni satir birakin):\n' +
      '```\n6\nstaging\n```\n' +
      '```\n6\nprod\n```\n' +
      '`staging` → dogrudan uygulanir.\n' +
      '`prod` → once bekleyen changeset\'ler listelenir, hicbir sey yazilmaz; ' +
      'uygulamak icin `6` + `onayla`, vazgecmek icin `6` + `iptal`.',
  },
];

/**
 * Menu yalnizca bu grupta yetkili VE bu kopyanin dinledigi islemleri listeler.
 * Grupta yetkili islem olup hicbirini bu kopya dinlemiyorsa null doner: menuyu
 * diger makinedeki kopya basar, bu kopya sessiz kalir.
 */
function buildMenu(perm) {
  const yetkili = OPERATIONS.filter((op) => isAllowed(perm, op.cmd));
  if (yetkili.length === 0) {
    return '**OSEM Islem Botu** — bu grupta yetkili islem tanimlanmamis. (.env\'de `WEBEX_ROOM_ID_<GRUP>_YETKILER` satirini kontrol edin.)';
  }
  const items = yetkili.filter((op) => isAllowed(LISTENED, op.cmd));
  if (items.length === 0) return null;
  return (
    '**OSEM Islem Botu** — bu grupta yapilabilecek islemler:\n\n' +
    items.map((op) => op.menuText).join('\n\n') +
    '\n\nIslemleri gormek icin: `islemler`'
  );
}

async function handleOperationOne(bot, username) {
  if (!username) {
    await bot.say('1. islem icin ikinci satira kullanici adini (e-posta) girmelisiniz.\n\nOrnek:\n```\n1\nkullanici@ornek.com\n```');
    return;
  }

  try {
    await changeTemporaryPassword(username, {
      onActive: async () => {
        await bot.say(
          `✅ \`${username}\` icin gecici sifre olusturuldu — simdi giris yapabilirsiniz. Sifre ~30 saniye sonra geri alinacak.`
        );
      },
    });
    await bot.say(`⏱️ Sure doldu — \`${username}\` sifresi eski haline geri alindi.`);
  } catch (err) {
    const detail = err.response
      ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 400)}`
      : err.message;
    await bot.say(`❌ Sifre degistirme sirasinda hata olustu:\n\`\`\`\n${detail}\n\`\`\``);
  }
}

async function handleOperationTwo(bot, query) {
  if (!query) {
    await bot.say('2. islem icin ikinci satira SELECT sorgunuzu girmelisiniz.\n\nOrnek:\n```\n2\nSELECT * FROM tablo\n```');
    return;
  }

  await bot.say('Sorgu kontrol ediliyor ve transaction icinde (rollback ile) calistiriliyor...');

  try {
    const result = await handleSelectQuery(query);
    if (!result.ok) {
      await bot.say(`⚠️ ${result.reason}`);
      return;
    }
    await bot.say(
      `✅ Sorgu calistirildi (${result.rowCount} satir). Excel dosyasi olusturuldu:\n\`\`\`\n${result.fullPath}\n\`\`\``
    );
  } catch (err) {
    await bot.say(`❌ Sorgu calistirilirken hata olustu:\n\`\`\`\n${err.message}\n\`\`\``);
  }
}

// Takip araligi: varsayilan 3 dk, `3 <dakika>` ile odaya ozel degistirilebilir
// (parseMergeInterval + sinirlar lib/parse.js'te, test-offline.js'te test ediliyor).
const mergeWatchers = new Map(); // roomId -> { timer, dakika }

function stopMergeWatch(roomId) {
  const watcher = mergeWatchers.get(roomId);
  if (watcher) {
    clearInterval(watcher.timer);
    mergeWatchers.delete(roomId);
  }
}

function startMergeWatch(bot, dakika) {
  const roomId = bot.room.id;
  stopMergeWatch(roomId); // aralik degismis olabilir; eski timer birakilmaz

  const timer = setInterval(async () => {
    try {
      const status = await ArgoControl();

      if (status === 'Progressing') {
        await bot.say(`🔄 **Argo Merge Durumu:** merge hala devam ediyor (Progressing). ${dakika} dakika sonra tekrar kontrol edilecek.`);
        return;
      }

      stopMergeWatch(roomId);
      if (status === 'Healthy') {
        await bot.say('✅ **Argo Merge Durumu:** merge tamamlandi — uygulama Healthy.');
      } else {
        await bot.say(`⚠️ **Argo Merge Durumu:** takip sonlandi, beklenmeyen durum: \`${status || 'bilinmiyor'}\``);
      }
    } catch (err) {
      try {
        await bot.say(`⚠️ Argo merge kontrolu basarisiz oldu, ${dakika} dakika sonra tekrar denenecek:\n\`\`\`\n${err.message}\n\`\`\``);
      } catch (sayErr) {
        console.error('Merge takip mesaji gonderilemedi:', sayErr.message);
      }
    }
  }, dakika * 60 * 1000);

  mergeWatchers.set(roomId, { timer, dakika });
}

async function handleOperationThree(bot, rest) {
  const { dakika, uyari, verildi } = parseMergeInterval(rest);
  if (uyari) await bot.say(uyari);

  // Bekleyen merge notlari Argo cagrisindan ONCE gosterilir: Argo'ya
  // ulasilamasa bile release alan kisi notlari gormus olur.
  try {
    const notes = listNotes();
    if (notes.length > 0) {
      await bot.say(formatNotes(notes));
      clearNotes();
    }
  } catch (err) {
    console.error('Merge notlari gosterilemedi:', err.message);
  }

  let status;
  try {
    status = await ArgoControl();
  } catch (err) {
    await bot.say(`❌ Argo Merge Durumu alinamadi:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  if (status === 'Healthy') {
    await bot.say('✅ **Argo Merge Durumu:** Healthy — su anlik devam eden bir merge yok.');
    return;
  }

  if (status === 'Progressing') {
    const mevcut = mergeWatchers.get(bot.room.id);

    if (mevcut && !verildi) {
      await bot.say(
        `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Takip zaten aktif, bitene kadar ${mevcut.dakika} dakikada bir bildirim atilmaya devam edilecek.`
      );
      return;
    }

    if (mevcut && mevcut.dakika === dakika) {
      await bot.say(
        `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Takip zaten ${dakika} dakikalik aralikla aktif.`
      );
      return;
    }

    // Yeni takip ya da kullanicinin verdigi yeni aralikla yeniden kurulum.
    startMergeWatch(bot, dakika);
    await bot.say(
      mevcut
        ? `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Kontrol araligi ${mevcut.dakika} dk → **${dakika} dk** olarak guncellendi.`
        : `🔄 **Argo Merge Durumu:** merge devam ediyor (Progressing). Bitene kadar ${dakika} dakikada bir bu gruba bildirim atilacak.`
    );
    return;
  }

  await bot.say(`⚠️ **Argo Merge Durumu:** \`${status || 'bilinmiyor'}\``);
}

async function handleOperationFour(bot, trigger, note) {
  if (!note) {
    await bot.say('4. islem icin ikinci satira notunuzu yazmalisiniz.\n\nOrnek:\n```\n4\nCache temizlensin\n```');
    return;
  }

  const author =
    (trigger.person && trigger.person.displayName) || trigger.personEmail || 'bilinmiyor';

  try {
    addNote({ author, text: note });
    const bekleyen = listNotes().length;
    await bot.say(
      `📝 Not kaydedildi (bekleyen not: ${bekleyen}). Bir sonraki 3. islemde release alan kisiye gosterilecek.`
    );
  } catch (err) {
    await bot.say(`❌ Not kaydedilemedi:\n\`\`\`\n${err.message}\n\`\`\``);
  }
}

// --- 5. islem: Branch kod incelemesi (yerel yapay zeka) -------------------

async function handleOperationFive(bot, rest) {
  const istek = kodReview.branchCoz(rest);
  if (istek.hata) {
    await bot.say(
      (istek.hata === 'bos' ? '5. islem icin branch adini yazmalisiniz.' : `⚠️ ${istek.hata}`) +
        '\n\nOrnek:\n```\n5 APTY-123\n```\n' +
        kodReview.YEREL_AI_UYARISI
    );
    return;
  }

  if (kodReview.mesgulMu()) {
    await bot.say('⏳ Su anda devam eden bir kod incelemesi var. Bitmesini bekleyip tekrar deneyin.');
    return;
  }
  // Ayni git deposunu 6. islem de kullaniyor.
  if (liquibaseMesgulMu()) {
    await bot.say('⏳ Su anda calisan bir liquibase islemi var (ayni git deposu). Bitmesini bekleyip tekrar deneyin.');
    return;
  }

  const { branch, aranan } = istek;
  await bot.say(
    `${kodReview.YEREL_AI_UYARISI}\n\n` +
      `🔎 \`${branch}\` branch'i cekiliyor, mesajinda \`${aranan}\` gecen commit'ler araniyor…`
  );

  let sonuc;
  try {
    sonuc = await kodReview.kodReviewYap({
      branch,
      aranan,
      commitlerBulundu: async ({ commitler, kirpildi, fazla }) => {
        const liste = commitler
          .slice(-10)
          .map((c) => `- \`${c.kisa}\` ${c.tarih} · ${c.yazar} · ${c.mesaj}`)
          .join('\n');
        await bot.say(
          `📝 **${commitler.length} commit** bulundu` +
            (commitler.length > 10 ? ' (son 10 tanesi):' : ':') +
            `\n${liste}\n\n` +
            (fazla ? '_Commit siniri asildi; yalnizca en yeni commit\'ler inceleniyor._\n' : '') +
            (kirpildi ? '_Diff cok buyuk; boyut sinirinda kesildi, kalan kisim incelenmeyecek._\n' : '') +
            '🤖 Yerel model inceliyor… Bu birkac dakika surebilir.'
        );
      },
    });
  } catch (err) {
    await bot.say(`❌ Kod incelemesi yapilamadi:\n${kodReview.hataMesaji(err)}`);
    return;
  }

  if (!sonuc.ok) {
    await bot.say(`⚠️ ${sonuc.mesaj}`);
    return;
  }

  // Ayrintili rapor SHARED_FOLDER'a yazilir; Webex'e puan + ozet + dosya yolu gider.
  const dosya = kodReview.dosyayaYaz(branch, kodReview.raporOlustur({ branch, ...sonuc }));
  const bulgu = kodReview.bulguSay(sonuc.govde);
  const baslik =
    `🧐 **Kod incelemesi — \`${branch}\`** · Puan: ${kodReview.puanEtiketi(sonuc.puan)}\n` +
    `${sonuc.commitler.length} commit · model \`${sonuc.model}\` (yerel) · ${sonuc.sureSn} sn` +
    (sonuc.yarim ? '\n_Model token sinirina takildi; inceleme yarim kalmis olabilir._' : '');

  if (dosya) {
    await bot.say(
      `${baslik}\n\n` +
        `**Ozet**\n${kodReview.ozetCikar(sonuc.govde)}\n\n` +
        `**Bulgular:** 🔴 ${bulgu.kritik} kritik · 🟠 ${bulgu.onemli} onemli · 🟡 ${bulgu.kucuk} kucuk\n\n` +
        `📄 Ayrintili inceleme:\n\`\`\`\n${dosya}\n\`\`\``
    );
    return;
  }

  // SHARED_FOLDER yok/yazilamadi: inceleme sohbete parca parca basilir.
  const parcalar = kodReview.parcala(`${baslik}\n\n${sonuc.govde}`);
  const gonderilecek = parcalar.slice(0, kodReview.WEBEX_MAKS_PARCA);
  for (const parca of gonderilecek) {
    await bot.say(parca);
  }
  await bot.say(
    (parcalar.length > gonderilecek.length
      ? `✂️ Inceleme cok uzun; ilk ${gonderilecek.length}/${parcalar.length} parca gosterildi.\n`
      : '') +
      '⚠️ Ayrintili rapor dosyaya yazilamadi (`SHARED_FOLDER` tanimli/erisilebilir degil).'
  );
}

// --- 6. islem: Liquibase ---------------------------------------------------

// Prod'a yazmadan once onizleme zorunlu. Onizleme sonucu odaya ozel saklanir;
// suresi dolarsa yeniden onizleme istenir (arada changelog degismis olabilir).
const PROD_ONAY_TTL_MS = 15 * 60 * 1000;
const prodOnaylar = new Map(); // roomId -> {zaman, kim, bekleyenAdet, sqlDosyasi, commit}

const LIQUIBASE_KULLANIM =
  '6. islem icin ikinci satira ortami yazmalisiniz.\n\n' +
  '```\n6\nstaging\n```\n' +
  '```\n6\nprod\n```\n' +
  '`prod` once yalnizca onizleme yapar; uygulamak icin `6` + `onayla`.';

// Webex mesaji sisirmesin diye liste kirpilir; tam liste run.cmd ciktisinda.
const CHANGESET_LISTE_SINIRI = 25;

function formatChangesetListesi(liste, adet, bosMesaji) {
  if (!adet) return bosMesaji;

  const satirlar = liste.slice(0, CHANGESET_LISTE_SINIRI).map((c, i) => `${i + 1}. \`${c}\``);
  if (adet > satirlar.length) {
    satirlar.push(`_… ve ${adet - satirlar.length} changeset daha._`);
  }
  return satirlar.join('\n');
}

function formatBekleyenler(bekleyenler, adet) {
  return formatChangesetListesi(bekleyenler, adet, '_Bekleyen changeset yok — veritabani guncel._');
}

function formatUygulananlar(uygulananlar, adet) {
  return formatChangesetListesi(uygulananlar, adet, '_Uygulanan changeset yok — veritabani zaten guncelmis._');
}

function senkronOzeti(senk) {
  const branchNotu =
    senk.oncekiBranch === 'prod'
      ? ''
      : ` (depo \`${senk.oncekiBranch}\` branch'inden \`prod\`'a alindi)`;
  const commitNotu =
    senk.yeniCommitSayisi > 0
      ? `${senk.yeniCommitSayisi} yeni commit cekildi → \`${senk.commit}\``
      : `zaten gunceldi → \`${senk.commit}\``;
  return `📥 Changelog'lar senkronlandi: ${commitNotu}${branchNotu}`;
}

async function handleOperationSix(bot, trigger, rest) {
  const arg = (rest || '').trim().toLowerCase();
  const kim = (trigger.person && trigger.person.displayName) || trigger.personEmail || 'bilinmiyor';

  if (!arg) {
    await bot.say(LIQUIBASE_KULLANIM);
    return;
  }

  if (arg === 'iptal') {
    const vardi = prodOnaylar.delete(bot.room.id);
    await bot.say(vardi ? '🚫 Bekleyen prod onayi iptal edildi.' : 'Bekleyen prod onayi yok.');
    return;
  }

  if (liquibaseMesgulMu()) {
    await bot.say('⏳ Su anda calisan bir liquibase islemi var. Bitmesini bekleyip tekrar deneyin.');
    return;
  }

  // 5. islem ayni depoda branch fetch ediyorsa git cakismasin.
  if (kodReview.gitMesgulMu()) {
    await bot.say('⏳ Kod incelemesi su anda ayni git deposundan branch cekiyor. Birkac saniye sonra tekrar deneyin.');
    return;
  }

  if (arg === 'onayla' || arg === 'onay') {
    await handleLiquibaseOnay(bot, kim);
    return;
  }

  if (arg !== 'staging' && arg !== 'prod') {
    await bot.say(`Bilinmeyen ortam: \`${arg}\`\n\n${LIQUIBASE_KULLANIM}`);
    return;
  }

  const prod = arg === 'prod';

  await bot.say(
    `🔄 \`${arg}\` icin changelog'lar \`prod\` branch'inden cekiliyor, ardindan liquibase ` +
      `${prod ? '**onizleme** modunda (veritabanina yazmadan)' : '**update** modunda'} calisacak. Birkac dakika surebilir…`
  );

  let senk;
  try {
    senk = await changeloglariSenkronla();
  } catch (err) {
    await bot.say(`❌ Changelog senkronizasyonu basarisiz:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  let sonuc;
  try {
    sonuc = await liquibaseCalistir({ profil: arg, mod: prod ? 'preview' : 'update' });
  } catch (err) {
    await bot.say(`${senkronOzeti(senk)}\n\n❌ Liquibase calistirilamadi:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  if (!sonuc.basarili) {
    prodOnaylar.delete(bot.room.id);
    await bot.say(
      `${senkronOzeti(senk)}\n\n❌ **Liquibase hata verdi** (\`${arg}\`, ${sonuc.sureSn} sn):\n` +
        `\`\`\`\n${(sonuc.hataMesaji || 'bilinmeyen hata').slice(0, 1200)}\n\`\`\``
    );
    return;
  }

  if (!prod) {
    await bot.say(
      `${senkronOzeti(senk)}\n\n` +
        `✅ **Liquibase calisti — staging** (${sonuc.sureSn} sn)\n` +
        `DB: \`${sonuc.url}\` · sema \`${sonuc.sema}\` · dropFirst \`${sonuc.dropFirst}\`\n\n` +
        `**Uygulanan changeset: ${sonuc.uygulanan}**\n\n` +
        formatUygulananlar(sonuc.uygulananlar, sonuc.uygulanan)
    );
    return;
  }

  // Prod: yalnizca onizleme yapildi, onay bekleniyor.
  if (!sonuc.bekleyenAdet) {
    prodOnaylar.delete(bot.room.id);
    await bot.say(
      `${senkronOzeti(senk)}\n\n` +
        `✅ **Prod zaten guncel** — uygulanacak changeset yok. Hicbir degisiklik yapilmadi.`
    );
    return;
  }

  prodOnaylar.set(bot.room.id, {
    zaman: Date.now(),
    kim,
    bekleyenAdet: sonuc.bekleyenAdet,
    sqlDosyasi: sonuc.sqlDosyasi,
    commit: senk.commit,
  });

  await bot.say(
    `${senkronOzeti(senk)}\n\n` +
      `🔍 **PROD ONIZLEME** — veritabanina **hicbir sey yazilmadi** (${sonuc.sureSn} sn)\n` +
      `DB: \`${sonuc.url}\` · sema \`${sonuc.sema}\` · dropFirst \`${sonuc.dropFirst}\`\n\n` +
      `**Uygulanacak changeset sayisi: ${sonuc.bekleyenAdet}**\n\n` +
      `${formatBekleyenler(sonuc.bekleyenler, sonuc.bekleyenAdet)}\n\n` +
      `Uretilecek SQL:\n\`\`\`\n${sonuc.sqlDosyasi}\n\`\`\`\n` +
      `⚠️ Uygulamak icin **${Math.round(PROD_ONAY_TTL_MS / 60000)} dakika** icinde:\n` +
      '```\n6\nonayla\n```\n' +
      'Vazgecmek icin: `6` + `iptal`'
  );
}

async function handleLiquibaseOnay(bot, kim) {
  const onay = prodOnaylar.get(bot.room.id);
  if (!onay) {
    await bot.say('Bekleyen bir prod onayi yok. Once `6` + `prod` ile onizleme alin.');
    return;
  }

  if (Date.now() - onay.zaman > PROD_ONAY_TTL_MS) {
    prodOnaylar.delete(bot.room.id);
    await bot.say(
      `⌛ Onizlemenin suresi doldu (${Math.round(PROD_ONAY_TTL_MS / 60000)} dk). ` +
        'Guvenlik icin `6` + `prod` ile yeniden onizleme alin.'
    );
    return;
  }

  // Onay tek kullanimlik: hata da olsa tekrar onizleme alinmali.
  prodOnaylar.delete(bot.room.id);

  await bot.say(
    `🚀 **PROD'A UYGULANIYOR** — ${onay.bekleyenAdet} changeset (onizleme: ${onay.kim}, onay: ${kim}). ` +
      'Changelog\'lar onizlemedeki hali ile kullanilir, yeniden cekilmez.'
  );

  let sonuc;
  try {
    sonuc = await liquibaseCalistir({ profil: 'prod', mod: 'update' });
  } catch (err) {
    await bot.say(`❌ Prod liquibase calistirilamadi:\n\`\`\`\n${err.message}\n\`\`\``);
    return;
  }

  if (!sonuc.basarili) {
    await bot.say(
      `❌ **PROD LIQUIBASE HATA VERDI** (${sonuc.sureSn} sn) — changelog \`${onay.commit}\`\n` +
        `\`\`\`\n${(sonuc.hataMesaji || 'bilinmeyen hata').slice(0, 1200)}\n\`\`\`\n` +
        (sonuc.basarisizChangeSet ? `💥 **Patlayan changeset:** \`${sonuc.basarisizChangeSet}\`\n` : '') +
        '\n⚠️ Liquibase her changeset\'i ayri uygular — **hatadan onceki changeset\'ler UYGULANDI:**\n\n' +
        `**${sonuc.uygulanan} changeset uygulandi**\n\n` +
        `${formatUygulananlar(sonuc.uygulananlar, sonuc.uygulanan)}\n\n` +
        'Guncel durumu gormek icin `6` + `prod` ile yeniden onizleme alin.'
    );
    return;
  }

  await bot.say(
    `✅ **PROD LIQUIBASE TAMAMLANDI** (${sonuc.sureSn} sn)\n` +
      `Changelog commit: \`${onay.commit}\`\n` +
      `DB: \`${sonuc.url}\` · sema \`${sonuc.sema}\` · dropFirst \`${sonuc.dropFirst}\`\n\n` +
      `**Uygulanan changeset: ${sonuc.uygulanan}** (onizlemede beklenen: ${onay.bekleyenAdet})\n\n` +
      formatUygulananlar(sonuc.uygulananlar, sonuc.uygulanan)
  );
}

/**
 * Botun etiketlendigi (mention) tum mesajlari yakalar.
 */
framework.hears(/.*/, async (bot, trigger) => {
  const message = trigger.message || {};
  const botName = (framework.person && framework.person.displayName) || '';

  // Env'de tanimli olmayan oda/DM — hic yanit verme.
  const perm = ROOM_PERMS.get(bot.room.id);
  if (!perm) {
    console.log(`Tanimsiz oda/DM mesaji yoksayildi: "${bot.room.title || '?'}" (roomId: ${bot.room.id})`);
    return;
  }

  // Mention'li mesajlarda `text` alaninda satir sonlari (shift+enter) kaybolur;
  // bu yuzden varsa `html` alanindan satir sonlarini koruyarak metin uretilir.
  // Grup odasinda mention metne bot adi olarak girer ("OSEM Bot islemler") — ayikla.
  const rawText = message.html
    ? htmlToText(message.html, botName)
    : (trigger.text || message.text || '');
  const text = stripBotMention(rawText, botName);
  const { command, rest } = parseInput(text);

  const cmdLower = command.toLowerCase();

  if (cmdLower === 'islemler' || cmdLower === 'help' || cmdLower === 'yardim' || cmdLower === '') {
    const menu = buildMenu(perm);
    if (menu) await bot.say(menu);
    return;
  }

  if (!OPERATIONS.some((op) => op.cmd === command)) {
    const menu = buildMenu(perm);
    if (menu) await bot.say(`Anlasilmayan komut: \`${command}\`\n\n${menu}`);
    return;
  }

  // Bu islem baska bir makinedeki kopyaya ait — cevap verme.
  if (!isAllowed(LISTENED, command)) {
    console.log(`Islem ${command} bu kopyada dinlenmiyor (DINLENEN_ISLEMLER), yoksayildi.`);
    return;
  }

  if (!isAllowed(perm, command)) {
    const menu = buildMenu(perm);
    await bot.say(`⛔ \`${command}\` islemi bu grupta yetkili degil.${menu ? `\n\n${menu}` : ''}`);
    return;
  }

  switch (command) {
    case '1':
      await handleOperationOne(bot, rest);
      break;
    case '2':
      await handleOperationTwo(bot, rest);
      break;
    case '3':
      await handleOperationThree(bot, rest);
      break;
    case '4':
      await handleOperationFour(bot, trigger, rest);
      break;
    case '5':
      await handleOperationFive(bot, rest);
      break;
    case '6':
      await handleOperationSix(bot, trigger, rest);
      break;
  }
});

framework.on('spawn', (bot, id, addedBy) => {
  if (addedBy && ROOM_PERMS.has(bot.room.id)) {
    bot.say('Merhaba! OSEM Islem Botu hazir. Islemleri gormek icin beni etiketleyip `islemler` yazin.');
  }
});
