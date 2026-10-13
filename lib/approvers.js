'use strict';

/**
 * Isimleri karsilastirmak icin normalize eder: bastaki/sondaki bosluklar atilir,
 * ic bosluklar teke iner, Turkce'ye uygun buyuk harfe cevrilir (i -> İ, ı -> I).
 */
function normalizeName(s) {
  return (s || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR');
}

/**
 * Env'deki AUTHORIZED_APPROVERS (virgulle ayrilmis) listesini doner.
 */
function getApprovers() {
  return (process.env.AUTHORIZED_APPROVERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Verilen gorunen ad (Webex profil adi) yetkili onaycilardan biri mi?
 */
function isAuthorizedApprover(displayName) {
  const target = normalizeName(displayName);
  if (!target) return false;
  return getApprovers().some((a) => normalizeName(a) === target);
}

module.exports = { getApprovers, isAuthorizedApprover, normalizeName };
