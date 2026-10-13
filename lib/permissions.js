'use strict';

// Oda (grup) bazli yetkilendirme.
// .env kalibi:
//   WEBEX_ROOM_ID_GRUP1="Y2lzY29..."       → grup tanimi (deger = room id)
//   WEBEX_ROOM_ID_GRUP1_YETKILER="1,2,3"   → izinli komutlar ("all" = hepsi)
// Duz WEBEX_ROOM_ID (soneksiz) grup sayilmaz (geriye uyum).
// _YETKILER satiri yoksa o grupta hicbir islem yetkili degildir; bot yine de
// yanit verir ki konfig hatasi fark edilsin.
//
// Makine bazli dinleme (bot birden fazla bilgisayarda calisiyorsa):
//   DINLENEN_ISLEMLER="1,2,3"   → bu kopya yalnizca bu islemlere yanit verir
// Bos/tanimsiz ya da "all" = hepsi (tek makinelik kurulum degismeden calisir).
// Kopyalar arasi cakisma KONTROL EDILMEZ; dagilim .env'lerde dogru yapilmali.

function parseOpList(raw) {
  const s = (raw || '').trim();
  const all = s.toLowerCase() === 'all';
  const allowed = all ? new Set() : new Set(s.split(',').map((x) => x.trim()).filter(Boolean));
  return { all, allowed };
}

/**
 * Env objesinden oda yetkilerini cikarir.
 * @returns {Map<string, {group: string, all: boolean, allowed: Set<string>}>} roomId → yetki
 */
function loadRoomPermissions(env) {
  const rooms = new Map();
  for (const [key, value] of Object.entries(env)) {
    const m = key.match(/^WEBEX_ROOM_ID_(.+)$/);
    if (!m || m[1].endsWith('_YETKILER') || !value || !value.trim()) continue;

    const group = m[1];
    const { all, allowed } = parseOpList(env[`WEBEX_ROOM_ID_${group}_YETKILER`]);
    rooms.set(value.trim(), { group, all, allowed });
  }
  return rooms;
}

/**
 * Bu kopyanin dinledigi islemler (DINLENEN_ISLEMLER). Bos = hepsi.
 * Donen obje isAllowed ile kullanilir.
 */
function loadListenedOps(env) {
  const raw = (env.DINLENEN_ISLEMLER || '').trim();
  return raw ? parseOpList(raw) : { all: true, allowed: new Set() };
}

function isAllowed(perm, command) {
  return !!perm && (perm.all || perm.allowed.has(command));
}

module.exports = { loadRoomPermissions, loadListenedOps, isAllowed };
