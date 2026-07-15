const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

const UA_PROXY_LIST_URL = 'https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/UA/data.json';
const UA_PROXY_CANDIDATES = 6;
const UA_PROXY_TIMEOUT_MS = 7000;

let cachedList = null;
let cachedAt = 0;

async function getUaProxyList() {
  if (cachedList && Date.now() - cachedAt < 5 * 60 * 1000) return cachedList;
  const resp = await fetch(UA_PROXY_LIST_URL);
  const list = await resp.json();
  cachedList = list.filter((p) => p.protocol === 'socks5' || p.protocol === 'socks4');
  cachedAt = Date.now();
  return cachedList;
}

function fetchViaAgent(targetUrl, agent) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      targetUrl,
      {
        agent,
        headers: {
          Referer: new URL(targetUrl).origin + '/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        },
        timeout: UA_PROXY_TIMEOUT_MS
      },
      (response) => {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}

function isM3u8(contentType, url) {
  return /mpegurl/i.test(contentType || '') || /\.m3u8($|\?)/i.test(url);
}

function rewriteM3u8(text, baseUrl, proxyBase) {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) === '#') return line;
      let resolved;
      try {
        resolved = new URL(trimmed, baseUrl).toString();
      } catch (e) {
        return line;
      }
      return proxyBase + encodeURIComponent(resolved);
    })
    .join('\n');
}

module.exports = async function handler(req, res) {
  const target = req.query.url;
  if (!target) {
    res.status(400).send('missing url param');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch (e) {
    res.status(400).send('invalid url param');
    return;
  }

  let candidates;
  try {
    candidates = (await getUaProxyList()).slice(0, UA_PROXY_CANDIDATES);
  } catch (e) {
    res.status(502).send('failed to fetch UA proxy list: ' + e.message);
    return;
  }

  let result = null;
  const errors = [];
  for (const p of candidates) {
    try {
      const agent = new SocksProxyAgent(`${p.protocol}://${p.ip}:${p.port}`);
      result = await fetchViaAgent(targetUrl.toString(), agent);
      break;
    } catch (e) {
      errors.push(p.ip + ':' + p.port + ' -> ' + e.message);
    }
  }

  if (!result) {
    res.status(502).send('all UA proxies failed:\n' + errors.join('\n'));
    return;
  }

  const contentType = result.headers['content-type'] || 'text/plain';
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (isM3u8(contentType, targetUrl.pathname)) {
    const text = result.body.toString('utf8');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const proxyBase = `${proto}://${req.headers.host}${req.url.split('?')[0]}?url=`;
    const rewritten = rewriteM3u8(text, targetUrl.toString(), proxyBase);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.status(result.status).send(rewritten);
    return;
  }

  res.setHeader('Content-Type', contentType);
  res.status(result.status).send(result.body);
};
