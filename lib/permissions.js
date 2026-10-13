'use strict';

// Oda (grup) bazli yetkilendirme.
// .env kalibi:
//   WEBEX_ROOM_ID_GRUP1="Y2lzY29..."       → grup tanimi (deger = room id)
//   WEBEX_ROOM_ID_GRUP1_YETKILER="1,2,3"   → izinli komutlar ("all" = hepsi)
// Duz WEBEX_ROOM_ID (soneksiz) grup sayilmaz (geriye uyum).
// _YETKILER satiri yoksa o grupta hicbir islem yetkili degildir; bot yine de
// yanit verir ki konfig hatasi fark edilsin.

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
    const raw = (env[`WEBEX_ROOM_ID_${group}_YETKILER`] || '').trim();
    const all = raw.toLowerCase() === 'all';
    const allowed = all
      ? new Set()
      : new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));

    rooms.set(value.trim(), { group, all, allowed });
  }
  return rooms;
}

function isAllowed(perm, command) {
  return !!perm && (perm.all || perm.allowed.has(command));
}

module.exports = { loadRoomPermissions, isAllowed };
