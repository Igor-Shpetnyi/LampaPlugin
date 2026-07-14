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

    const body = await resp.arrayBuffer();
    return new Response(body, {
      status: resp.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': resp.headers.get('Content-Type') || 'text/plain'
      }
    });
  }
}
