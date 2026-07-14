function selfUrl(request) {
  return new URL(request.url).origin + new URL(request.url).pathname;
}

function isM3u8(contentType, url) {
  return /mpegurl/i.test(contentType || '') || /\.m3u8($|\?)/i.test(url);
}

// HLS playlists reference other playlists/segments by URL (absolute or
// relative). hls.js follows those directly, bypassing this proxy and
// hitting the same CORS wall — so every non-comment line gets rewritten
// to route back through us.
function rewriteM3u8(text, baseUrl, proxyBase) {
  return text.split('\n').map(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') return line;
    var resolved;
    try {
      resolved = new URL(trimmed, baseUrl).toString();
    } catch (e) {
      return line;
    }
    return proxyBase + encodeURIComponent(resolved);
  }).join('\n');
}

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('missing url param', { status: 400 });

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      return new Response('invalid url param', { status: 400 });
    }

    const resp = await fetch(targetUrl.toString(), {
      headers: {
        'Referer': targetUrl.origin + '/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });

    const contentType = resp.headers.get('Content-Type') || 'text/plain';

    if (isM3u8(contentType, targetUrl.pathname)) {
      const text = await resp.text();
      const proxyBase = selfUrl(request) + '?url=';
      const rewritten = rewriteM3u8(text, targetUrl.toString(), proxyBase);
      return new Response(rewritten, {
        status: resp.status,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/vnd.apple.mpegurl'
        }
      });
    }

    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': contentType
      }
    });
  }
}
