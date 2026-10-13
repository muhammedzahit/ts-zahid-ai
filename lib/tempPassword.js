'use strict';

const axios = require('axios');

/**
 * PROD_LOGIN_URI'ye admin bilgileriyle giris yapip bearer token doner.
 */
async function getAdminToken() {
  const loginUri = process.env.PROD_LOGIN_URI;
  const res = await axios.post(
    loginUri,
    {
      username: process.env.PROD_ADMIN_USERNAME,
      password: process.env.PROD_ADMIN_PASSWORD,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const data = res.data || {};
  // Cevap yapisi kesin bilinmedigi icin olasi alanlar denenir.
  const token =
    data.token ||
    data.accessToken ||
    data.access_token ||
    (data.data && (data.data.token || data.data.accessToken || data.data.access_token)) ||
    data.jwt;

  if (!token) {
    throw new Error(
      'Giris cevabinda bearer token bulunamadi. Cevap: ' + JSON.stringify(data).slice(0, 500)
    );
  }
  return token;
}

/**
 * PROD_LOGIN_URI'nin origin'ini alip ADMIN_TEMPORARY_PASSWORD_URI ile birlestirir.
 */
function buildTempPasswordUrl() {
  const tempPath = process.env.ADMIN_TEMPORARY_PASSWORD_URI;
  if (/^https?:\/\//i.test(tempPath)) {
    return tempPath;
  }
  const base = new URL(process.env.PROD_LOGIN_URI);
  return `${base.protocol}//${base.host}${tempPath.startsWith('/') ? '' : '/'}${tempPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Kullanicinin sifresini gecici olarak degistirir.
 *
 * Endpoint'in davranisi: istek gidince sifre HEMEN degisir, cevap ~30 saniye
 * bekletilir ve sure sonunda sifre eski haline geri alinir. Bu yuzden istek
 * kisa bir sure (grace period) hata dondurmezse sifre aktif kabul edilir ve
 * `onActive` cagrilir (bot "olusturuldu, giris yapabilirsiniz" mesajini atar).
 * Fonksiyon, istegin tamamlanmasini (~30 sn, sifrenin geri alinmasi) bekleyip
 * doner; hata varsa firlatir.
 */
async function changeTemporaryPassword(username, { onActive } = {}) {
  const token = await getAdminToken();
  const url = buildTempPasswordUrl();

  let error = null;
  const request = axios
    .post(
      url,
      {
        username,
        aesPassword: process.env.ADMIN_TEMPORARY_CHANGE_AES_PASSWORD,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        // Istek ~30 sn beklettigi icin timeout genis tutuldu.
        timeout: 60000,
      }
    )
    .catch((e) => {
      error = e;
    });

  // Aninda donen hatalari (401, 404, validasyon...) yakalamak icin kisa bekleme.
  await sleep(2500);
  if (error) throw error;

  // Hata gelmedi: sifre su an aktif.
  if (onActive) await onActive();

  // 30 sn'lik bekletmenin bitmesini (sifrenin geri alinmasini) bekle.
  await request;
  if (error) throw error;

  return true;
}

module.exports = { changeTemporaryPassword };
