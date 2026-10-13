#!/usr/bin/env node
// test.mjs — sıfır bağımlılık. node test.mjs
const https = require('node:https');
const { URL, URLSearchParams } = require('node:url');
const { Buffer } = require('node:buffer');

const ArgoControl = async () => {
	const START_URL =
	  'https://openshift-gitops-server-openshift-gitops.apps.hasaroto.apps.gbzocpbm01.trs.local/auth/login';

	const USERNAME = process.env.ARGO_USERNAME;
	const PASSWORD = process.env.ARGO_PASSWORD;

	// ── HTML entity decode — &amp; vs. yüzünden response_type kaybını önler ── ← FIX
	const htmlDecode = (s) =>
	  (s || '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;/g, "'")
		.replace(/&#x2F;/gi, '/');

	// ── Host bazlı cookie jar ──
	const jars = new Map();
	const jarFor = (h) => jars.get(h) || jars.set(h, new Map()).get(h);
	function storeCookies(host, setCookie) {
	  if (!setCookie) return;
	  const jar = jarFor(host);
	  for (const c of setCookie) {
		const [pair] = c.split(';');
		const i = pair.indexOf('=');
		if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
	  }
	}
	const cookieFor = (h) => {
	  const jar = jars.get(h);
	  return jar && jar.size ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : null;
	};

	// ── https.request → Promise ──
	function request(urlStr, { method = 'GET', headers = {}, body } = {}) {
	  const u = new URL(urlStr);
	  const ck = cookieFor(u.hostname);
	  const h = { ...headers, ...(ck && { cookie: ck }) };
	  if (body) h['content-length'] = Buffer.byteLength(body);
	  const opts = {
		method, hostname: u.hostname, port: u.port || 443,
		path: u.pathname + u.search, rejectUnauthorized: false, headers: h,
	  };
	  return new Promise((resolve, reject) => {
		const req = https.request(opts, (res) => {
		  storeCookies(u.hostname, res.headers['set-cookie']);
		  const chunks = [];
		  res.on('data', (d) => chunks.push(d));
		  res.on('end', () => resolve({
			status: res.statusCode, headers: res.headers,
			body: Buffer.concat(chunks).toString('utf8'), url: urlStr,
		  }));
		});
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	  });
	}

	let submitted = false, finalCode = null;
	async function run(start, max = 25) {
	  let cur = start, o = { method: 'GET' };
	  for (let i = 0; i < max; i++) {
		const res = await request(cur, o);

		const loc = res.headers.location;
		if (res.status >= 300 && res.status < 400 && loc) {
		  const next = new URL(htmlDecode(loc), cur);   // ← FIX: Location'ı da decode et (savunma amaçlı)
		  const code = next.searchParams.get('code');
		  if (code) finalCode = code;
		  cur = next.href; o = { method: 'GET' };
		  continue;
		}

		const isLoginForm = /name="password"/.test(res.body) && /name="csrf"/.test(res.body);
		if (isLoginForm && !submitted) {
		  submitted = true;
		  const pick = (re) => (res.body.match(re) || [])[1];
		  const csrf   = htmlDecode(pick(/name="csrf"\s+value="([^"]+)"/));    // ← FIX
		  const then   = htmlDecode(pick(/name="then"\s+value="([^"]+)"/));    // ← FIX (asıl kritik olan)
		  const action = htmlDecode(pick(/<form[^>]*action="([^"]+)"/));       // ← FIX
		  cur = new URL(action, cur).href;
		  o = {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ then: then || '', csrf, username: USERNAME, password: PASSWORD }).toString(),
		  };
		  continue;
		}

		return res;
	  }
	  throw new Error('Çok fazla adım');
	}

	const res = await run(START_URL);
	let token = "";
	for (const [host, jar] of jars) {
	  if(host == 'openshift-gitops-server-openshift-gitops.apps.hasaroto.apps.gbzocpbm01.trs.local')
		token = jar?.get('argocd.token');
	}

	const HOST = 'openshift-gitops-server-openshift-gitops.apps.hasaroto.apps.gbzocpbm01.trs.local';
	const TOKEN = token;   // login script'inden aldığın argocd.token değeri

	const url = `https://${HOST}/api/v1/applications/hasaroto?appNamespace=openshift-gitops`;

	const opts = {
	  method: 'GET',
	  headers: {
		'Accept': 'application/json',
		'Cookie': `argocd.token=${TOKEN}`,   // ← -b karşılığı
	  },
	  rejectUnauthorized: false,             // ← --insecure karşılığı
	};

	return new Promise((resolve, reject) => {
	  const req = https.request(url, opts, (res) => {
		const chunks = [];
		res.on('data', (d) => chunks.push(d));
		res.on('end', () => {
		  const body = Buffer.concat(chunks).toString('utf8');
		  try {
			const app = JSON.parse(body);
			console.log('name  :', app.metadata?.name);
			console.log('sync  :', app.status?.sync?.status);
			console.log('health:', app.status?.health?.status);
			resolve(app.status?.health?.status);
		  } catch {
			reject(new Error('Beklenmeyen Argo yaniti: ' + body.slice(0, 500)));
		  }
		});
	  });
	  req.on('error', reject);
	  req.end();
	});
}

module.exports = ArgoControl;