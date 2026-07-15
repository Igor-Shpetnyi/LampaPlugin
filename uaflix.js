/* UAFLIX plugin for Lampa — personal use.
 * Parses uafix.net (DLE-based) + zetvideo.net player backend.
 * V1 scope: search, movies, and "full archive" series (zetvideo /serial/{id} tree).
 * "In-progress" series (zetvideo /vod/{id} per-episode) get basic single-episode playback only —
 * full episode-by-episode navigation for that case is a planned follow-up.
 */
(function () {
    'use strict';

    function startPlugin() {
        if (window.uaflix_plugin) return;
        window.uaflix_plugin = true;

        log('plugin init');

        // ---------------------------------------------------------------
        // Config & storage
        // ---------------------------------------------------------------

        var DOMAIN_KEY = 'uaflix_domain';
        var DEFAULT_DOMAIN = 'uafix.net';
        var PROXY_KEY = 'uaflix_proxy';
        // uafix.net and zetvideo.net send no Access-Control-Allow-Origin header,
        // so Lampa.Reguest (plain browser fetch/XHR under the hood) gets blocked
        // by CORS. This Worker fetches server-side and re-serves with an open
        // CORS header. Leave empty in settings to call sites directly (e.g. on
        // an Android build where the network layer might bypass CORS).
        var DEFAULT_PROXY = 'https://uaflix-cors-proxy.igor-shpetnyi.workers.dev/?url=';
        // Some content (actively-airing series episodes) is geo-gated to
        // Ukrainian IPs at the zetvideo.net level. The Cloudflare Worker above
        // can't satisfy that (its TCP Sockets API can't do proper SNI through
        // a proxied tunnel — confirmed, not just untried), so this second,
        // slower proxy routes through a rotating free Ukrainian SOCKS5 proxy
        // via a real Node.js runtime (Vercel), used only as a fallback when
        // the fast proxy comes back without a player.
        var UA_PROXY_KEY = 'uaflix_ua_proxy';
        var DEFAULT_UA_PROXY = 'https://lampa-plugin-eta.vercel.app/api/ua-proxy?url=';
        var MATCH_CACHE_KEY = 'uaflix_match_cache';
        var TREE_CACHE_KEY = 'uaflix_tree_cache';
        var MATCH_TTL = 1000 * 60 * 60 * 24 * 14; // 14 days
        var TREE_TTL = 1000 * 60 * 60 * 24 * 3;   // 3 days
        var MAX_CANDIDATE_PROBES = 6;              // how many search results we're willing to open when disambiguating

        function domain() {
            return Lampa.Storage.get(DOMAIN_KEY, DEFAULT_DOMAIN);
        }

        function baseUrl() {
            return 'https://' + domain();
        }

        var PROXY_OFF = '-';

        // Lampa.Storage.get() itself falls back to the default value when the
        // stored string is empty (verified live), so an empty field can never
        // mean "off" — a sentinel value is used instead.
        function proxy() {
            var v = Lampa.Storage.get(PROXY_KEY, DEFAULT_PROXY);
            return v === PROXY_OFF ? '' : v;
        }

        function viaProxy(url) {
            var p = proxy();
            return p ? (p + encodeURIComponent(url)) : url;
        }

        function uaProxy() {
            var v = Lampa.Storage.get(UA_PROXY_KEY, DEFAULT_UA_PROXY);
            return v === PROXY_OFF ? '' : v;
        }

        function viaUaProxy(url) {
            var p = uaProxy();
            return p ? (p + encodeURIComponent(url)) : url;
        }

        // Generic TTL key-value cache stored in Lampa.Storage, modeled after
        // the cache pattern used by other Lampa plugins (id -> {time, value}).
        function CacheBox(storageKey, ttl) {
            var self = this;

            self.get = function (id) {
                var all = Lampa.Storage.get(storageKey, {});
                var node = all[id];
                if (node && (Date.now() - node.time) < ttl) return node.value;
                return null;
            };

            self.set = function (id, value) {
                var all = Lampa.Storage.get(storageKey, {});
                all[id] = { time: Date.now(), value: value };
                // keep the cache from growing forever
                var keys = Object.keys(all);
                if (keys.length > 300) {
                    keys.sort(function (a, b) { return all[a].time - all[b].time; });
                    for (var i = 0; i < keys.length - 300; i++) delete all[keys[i]];
                }
                Lampa.Storage.set(storageKey, all);
            };

            self.clear = function () {
                Lampa.Storage.set(storageKey, {});
            };
        }

        var matchCache = new CacheBox(MATCH_CACHE_KEY, MATCH_TTL);
        var treeCache = new CacheBox(TREE_CACHE_KEY, TREE_TTL);

        // ---------------------------------------------------------------
        // Network — thin wrapper around Lampa.Reguest.
        // uafix.net/zetvideo.net send no Access-Control-Allow-Origin header,
        // so requests are routed through a small CORS-proxy Worker (see
        // DEFAULT_PROXY above), which also sets the Referer header that
        // zetvideo.net requires. Wrapped in try/catch and logged so failures
        // are diagnosable via remote-debug console instead of just a toast.
        // ---------------------------------------------------------------

        function log() {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[UAFLIX]');
            if (window.console && console.log) console.log.apply(console, args);
        }

        function requestRaw(proxiedUrl, origUrl, timeoutMs, onOk, onErr) {
            log('request ->', proxiedUrl);
            try {
                var network = new Lampa.Reguest();
                network.timeout(timeoutMs);

                network.silent(proxiedUrl, function (text) {
                    log('request ok <-', origUrl, 'len=' + (text ? text.length : 0));
                    onOk(text);
                }, function (a, b) {
                    log('request FAILED <-', origUrl, a, b);
                    if (onErr) onErr(a, b);
                }, false, { dataType: 'text' });
            } catch (e) {
                log('request THREW', origUrl, e && e.message, e);
                if (onErr) onErr(e);
            }
        }

        function request(url, onOk, onErr) {
            requestRaw(viaProxy(url), url, 15000, onOk, onErr);
        }

        // Slower (rotating free proxy), used only as a fallback for content
        // the fast proxy can't reach.
        function requestUa(url, onOk, onErr) {
            requestRaw(viaUaProxy(url), url, 25000, onOk, onErr);
        }

        // ---------------------------------------------------------------
        // uafix.net parsing
        // ---------------------------------------------------------------

        function decodeEntities(s) {
            return (s || '')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#039;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');
        }

        function absolutize(url) {
            if (!url) return url;
            if (url.indexOf('//') === 0) return 'https:' + url;
            if (url.indexOf('http') === 0) return url;
            return baseUrl() + url;
        }

        // Search results markup (confirmed live):
        // <a class="sres-wrap clearfix" href="URL">
        //   <div class="sres-img"><img src="POSTER" alt="TITLE" /></div>
        //   <div class="sres-text"><h2>TITLE</h2><div class="sres-desc">DESC</div></div>
        // </a>
        function parseSearchResults(html) {
            var results = [];
            var re = /<a class="sres-wrap clearfix" href="([^"]+)">\s*<div class="sres-img"><img src="([^"]+)"[^>]*>[\s\S]*?<h2>([\s\S]*?)<\/h2>/g;
            var m;
            while ((m = re.exec(html))) {
                var url = m[1];
                var type = url.indexOf('/serials/') > -1 ? 'series' : 'movie';
                results.push({
                    url: url,
                    poster: absolutize(m[2]),
                    title: decodeEntities(m[3]).trim(),
                    type: type
                });
            }
            return results;
        }

        function search(query, onOk, onErr) {
            var url = baseUrl() + '/?do=search&subaction=search&story=' + encodeURIComponent(query);
            request(url, function (html) {
                onOk(parseSearchResults(html));
            }, onErr);
        }

        // Movie/series page: year + zetvideo player id.
        // Confirmed markup:
        //   <span itemprop="dateCreated" class="year">1984</span>
        //   <iframe ... src="https://zetvideo.net/vod/22992" ...>  (or /serial/{id})
        function landingSlug(url) {
            var m = /\/serials\/([a-z0-9\-]+)\/?(?:$|\?)/.exec(url);
            return m ? m[1] : null;
        }

        function parsePageHtml(url, html) {
            var yearMatch = /itemprop="dateCreated" class="year">(\d{4})</.exec(html);
            var idMatch = /zetvideo\.net\/(vod|serial)\/(\d+)/.exec(html);
            if (!idMatch) return null;

            var series = seriesSlugAndEpisode(url);
            // Playerjs preview meta and the episode title (in Ukrainian
            // guillemets, e.g. Спадок 1 серія «This Is the Part...») live in
            // the same og/description tags on every content page — harvested
            // here so probing an episode's existence also gets us its real
            // title/poster for free, no extra request.
            var titleMatch = /«([^»]+)»/.exec(html);
            var posterMatch = /property="og:image" content="([^"]+)"/.exec(html);

            return {
                url: url,
                year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
                kind: idMatch[1],   // 'vod' | 'serial'
                zid: idMatch[2],
                series: series,                                          // {slug, season, episode} or null
                episodes: series ? discoverEpisodes(html, series.slug) : null,
                episodeTitle: titleMatch ? decodeEntities(titleMatch[1]) : '',
                poster: posterMatch ? posterMatch[1] : '',
                seasonCount: discoverSeasonCount(html)
            };
        }

        function resolvePageVia(requester, url, onOk, onErr) {
            requester(url, function (html) {
                var info = parsePageHtml(url, html);
                var seasonCountHere = discoverSeasonCount(html);

                if (info) {
                    info.seasonCount = Math.max(info.seasonCount || 1, seasonCountHere);
                    onOk(info);
                    return;
                }

                // Series *landing* pages (/serials/{slug}/) usually have no
                // player of their own — only individual episode pages do.
                // Fall back to whatever the earliest linked episode is, but
                // keep the season count we *did* see here (landing pages
                // reliably list every season; individual episode pages
                // often only mention their own).
                var slug = landingSlug(url);
                var episodes = slug ? discoverEpisodes(html, slug) : [];
                if (episodes.length) {
                    resolvePageVia(requester, episodeUrl(slug, episodes[0].season, episodes[0].episode), function (innerInfo) {
                        innerInfo.seasonCount = Math.max(innerInfo.seasonCount || 1, seasonCountHere);
                        onOk(innerInfo);
                    }, onErr);
                    return;
                }
                onErr('no_player');
            }, onErr);
        }

        // Some content (actively-airing series episodes) is geo-gated and
        // comes back with no player at all via the fast proxy — retry the
        // whole resolution through the Ukraine proxy before giving up.
        function resolvePage(url, onOk, onErr) {
            resolvePageVia(request, url, onOk, function () {
                log('resolvePage: fast proxy found no player, retrying via UA proxy', url);
                resolvePageVia(requestUa, url, onOk, onErr);
            });
        }

        // ---------------------------------------------------------------
        // "In-progress" series support: uafix.net doesn't expose a full
        // episode list for these (unlike the /serial/ JSON tree) — each
        // episode is its own page at a predictable URL, and the site links
        // a couple of neighbouring episodes from any given episode page.
        // We harvest those links to build a best-effort episode list.
        // ---------------------------------------------------------------

        function pad2(n) {
            n = String(n);
            return n.length < 2 ? '0' + n : n;
        }

        function escapeRegExp(s) {
            return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function seriesSlugAndEpisode(url) {
            var m = /\/serials\/([a-z0-9\-]+)\/season-(\d+)-episode-(\d+)\/?/.exec(url);
            if (!m) return null;
            return { slug: m[1], season: parseInt(m[2], 10), episode: parseInt(m[3], 10) };
        }

        function episodeUrl(slug, season, episode) {
            return baseUrl() + '/serials/' + slug + '/season-' + pad2(season) + '-episode-' + pad2(episode) + '/';
        }

        // Only counts season-XX-episode-YY links that belong to *this* slug —
        // pages routinely also link episodes of unrelated shows (related/
        // recently-watched widgets), which would otherwise contaminate the list.
        // Used only for the landing-page fallback in resolvePageVia() below —
        // real per-season episode lists come from probeSeasonEpisodes().
        function discoverEpisodes(html, slug) {
            var found = {};
            var re = new RegExp('/serials/' + escapeRegExp(slug) + '/season-(\\d+)-episode-(\\d+)', 'g');
            var m;
            while ((m = re.exec(html))) {
                var season = parseInt(m[1], 10), episode = parseInt(m[2], 10);
                found[season + '_' + episode] = { season: season, episode: episode };
            }
            var list = [];
            for (var k in found) if (found.hasOwnProperty(k)) list.push(found[k]);
            list.sort(function (a, b) { return a.season - b.season || a.episode - b.episode; });
            return list;
        }

        // Series *landing* pages list every season as plain "Сезон N" text
        // (individual episode pages usually only mention their own season),
        // so this is only meaningful on whatever page resolvePageVia() first
        // lands on — it takes the max across the whole resolve chain.
        function discoverSeasonCount(html) {
            var re = /Сезон\s*(\d+)/gi;
            var max = 0, m;
            while ((m = re.exec(html))) {
                var n = parseInt(m[1], 10);
                if (n > max) max = n;
            }
            return max || 1;
        }

        var MAX_EPISODES_PER_SEASON = 24;

        // Cheap pass: only checks existence + harvests title/poster for each
        // episode slot in a season (one page fetch each, no zetvideo/m3u8
        // resolution) — the actual video is resolved lazily, per episode,
        // only once the user picks or navigates to it.
        function probeSeasonEpisodes(slug, season, onDone) {
            var results = [];
            var remaining = MAX_EPISODES_PER_SEASON;

            var _loop = function (episode) {
                resolvePage(episodeUrl(slug, season, episode), function (info) {
                    results.push({
                        season: season,
                        episode: episode,
                        title: info.episodeTitle || ('Серія ' + episode),
                        poster: info.poster || ''
                    });
                    finish();
                }, finish);
            };
            for (var e = 1; e <= MAX_EPISODES_PER_SEASON; e++) _loop(e);

            function finish() {
                if (--remaining > 0) return;
                results.sort(function (a, b) { return a.episode - b.episode; });
                onDone(results);
            }
        }

        // Resolves one specific episode's playable file (fast proxy, UA fallback).
        function resolveEpisode(slug, season, episode, onOk, onErr) {
            resolvePage(episodeUrl(slug, season, episode), function (info) {
                resolveVod(info.zid, onOk, onErr);
            }, onErr);
        }

        // ---------------------------------------------------------------
        // zetvideo.net parsing
        // ---------------------------------------------------------------

        function parseVodHtml(html) {
            var fileMatch = /file\s*:\s*"([^"]+)"/.exec(html);
            if (!fileMatch) return null;
            var posterMatch = /poster\s*:\s*"([^"]*)"/.exec(html);
            return { file: fileMatch[1], poster: posterMatch ? posterMatch[1] : '' };
        }

        // /vod/{id} -> single Playerjs config, file is a plain URL string.
        // Same geo-gate as resolvePage() — retry via the Ukraine proxy if the
        // fast proxy comes back without a `file:` entry (blocked content
        // renders a trailer-only page with no player config at all).
        function resolveVod(id, onOk, onErr) {
            var url = 'https://zetvideo.net/vod/' + id;
            request(url, function (html) {
                var res = parseVodHtml(html);
                if (res) { onOk(res); return; }
                log('resolveVod: fast proxy found no file, retrying via UA proxy', id);
                requestUa(url, function (html2) {
                    var res2 = parseVodHtml(html2);
                    if (res2) { onOk(res2); return; }
                    onErr('no_file');
                }, onErr);
            }, onErr);
        }

        // /serial/{id} -> Playerjs config, file is a JSON string (voices -> seasons -> episodes).
        function resolveSerialTree(id, onOk, onErr) {
            var cached = treeCache.get(id);
            if (cached) { onOk(cached); return; }

            var url = 'https://zetvideo.net/serial/' + id;
            request(url, function (html) {
                // file:'[ ... ]', forbidden_quality: ...
                var fileMatch = /file\s*:\s*'([\s\S]*?)'\s*,\s*\r?\n?\s*forbidden_quality/.exec(html);
                if (!fileMatch) { onErr('no_tree'); return; }

                var tree;
                try {
                    tree = JSON.parse(fileMatch[1]);
                } catch (e) {
                    onErr('bad_tree_json');
                    return;
                }

                treeCache.set(id, tree);
                onOk(tree);
            }, onErr);
        }

        // ---------------------------------------------------------------
        // Matching: Lampa movie card -> uafix.net search result
        // ---------------------------------------------------------------

        function movieInfo(movie) {
            var isSeries = !!(movie.original_name || (movie.name && !movie.title));
            var title = movie.original_title || movie.original_name || movie.title || movie.name || '';
            var yearSrc = movie.release_date || movie.first_air_date || movie.last_air_date || '';
            return {
                title: title,
                year: parseInt((yearSrc || '').slice(0, 4), 10) || 0,
                isSeries: isSeries
            };
        }

        // Fetch year for a batch of candidates (bounded), used only when we
        // need to disambiguate between several same-type search results.
        function probeYears(candidates, onDone) {
            var limited = candidates.slice(0, MAX_CANDIDATE_PROBES);
            var results = [];
            var remaining = limited.length;

            if (!remaining) { onDone(results); return; }

            limited.forEach(function (c) {
                resolvePage(c.url, function (info) {
                    results.push({ candidate: c, info: info });
                    if (--remaining === 0) onDone(results);
                }, function () {
                    if (--remaining === 0) onDone(results);
                });
            });
        }

        // Returns either {auto: {candidate, info}} or {choices: [...]} or {none: true}
        function matchMovie(movie, candidates, onResult) {
            var wantType = movie.isSeries ? 'series' : 'movie';
            var filtered = candidates.filter(function (c) { return c.type === wantType; });

            if (!filtered.length) { onResult({ none: true }); return; }

            if (filtered.length === 1) {
                resolvePage(filtered[0].url, function (info) {
                    onResult({ auto: { candidate: filtered[0], info: info } });
                }, function () {
                    onResult({ none: true });
                });
                return;
            }

            probeYears(filtered, function (probed) {
                if (!probed.length) { onResult({ none: true }); return; }

                var exact = probed.filter(function (p) { return movie.year && p.info.year === movie.year; });

                if (exact.length === 1) {
                    onResult({ auto: exact[0] });
                } else {
                    // Not confident enough — let the user pick.
                    onResult({ choices: probed });
                }
            });
        }

        // ---------------------------------------------------------------
        // Playlist building (from the /serial/ tree)
        // ---------------------------------------------------------------

        function buildPlaylist(episodes) {
            return episodes.map(function (ep) {
                return {
                    title: (ep.title || '').trim(),
                    url: ep.file,
                    poster: ep.poster || ''
                };
            });
        }

        // ---------------------------------------------------------------
        // Playback
        // ---------------------------------------------------------------

        // Resume position, matched to real balancer plugin source (Online's
        // rezka.js): a stable hash of season+episode+original title (or just
        // the title for movies) keys into Lampa's own watched-progress store.
        function timelineFor(movie, seasonKey, episodeKey) {
            var title = movie.original_title || movie.original_name || movie.title || movie.name || '';
            var key = (seasonKey !== undefined && seasonKey !== null) ? [seasonKey, episodeKey, title].join('') : title;
            return Lampa.Timeline.view(Lampa.Utils.hash(key));
        }

        // zetvideo.net's CORS header is hardcoded to its own origin, so hls.js
        // (running as page JS) gets blocked fetching the m3u8 directly, same
        // as the resolver pages. The proxy Worker also rewrites URLs *inside*
        // m3u8 playlists to route variant playlists/segments back through
        // itself, so only the initial URL needs wrapping here.
        function playSingle(file, title, poster, useUa, timeline) {
            var wrap = useUa ? viaUaProxy : viaProxy;
            Lampa.Player.play({
                url: wrap(file),
                title: title,
                poster: poster || '',
                timeline: timeline
            });
        }

        // playlist: [{title, url, poster, timeline}], all URLs already
        // resolved (used by the full-archive /serial/ path, where the whole
        // tree — and every m3u8 URL in it — comes back in one request).
        function playFromPlaylist(playlist, startIndex, movie, useUa) {
            var wrap = useUa ? viaUaProxy : viaProxy;
            var item = playlist[startIndex];
            Lampa.Player.play({
                url: wrap(item.url),
                title: (movie.title || movie.name || '') + ' — ' + item.title,
                poster: item.poster || '',
                timeline: item.timeline
            });
            if (Lampa.Player.playlist) {
                Lampa.Player.playlist(playlist.map(function (p) {
                    return { title: p.title, url: wrap(p.url), poster: p.poster, timeline: p.timeline };
                }));
            }
        }

        // ---------------------------------------------------------------
        // UI flow
        // ---------------------------------------------------------------

        function showError(text, technical) {
            if (technical !== undefined) log('error:', text, technical);
            Lampa.Noty.show(text);
        }

        function pickCandidate(probed, onPick) {
            Lampa.Select.show({
                title: 'UAFLIX — уточніть, що відкрити',
                items: probed.map(function (p) {
                    return {
                        title: p.candidate.title + (p.info.year ? ' (' + p.info.year + ')' : ''),
                        probed: p
                    };
                }),
                onSelect: function (item) { onPick(item.probed); },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }

        function pickFromList(title, list, onPick) {
            Lampa.Select.show({
                title: title,
                items: list.map(function (item, idx) {
                    return { title: (item.title || ('#' + (idx + 1))).trim(), idx: idx };
                }),
                onSelect: function (sel) { onPick(sel.idx); },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }

        // Same as pickFromList, but shows each episode's poster where known
        // (real Lampa selectbox template — confirmed against bookmarks-sync.js)
        // and pre-focuses the current/likely-next episode instead of the top.
        function pickEpisodeList(title, list, onPick, preselectIdx) {
            Lampa.Select.show({
                title: title,
                items: list.map(function (item, idx) {
                    var entry = { title: (item.title || ('#' + (idx + 1))).trim(), idx: idx };
                    if (item.poster) {
                        entry.template = 'selectbox_icon';
                        entry.icon = '<img src="' + item.poster + '" />';
                    }
                    if (preselectIdx === idx) entry.selected = true;
                    return entry;
                }),
                onSelect: function (sel) { onPick(sel.idx); },
                onBack: function () { Lampa.Controller.toggle('content'); }
            });
        }

        function seasonNumberFromTitle(title) {
            var m = /(\d+)/.exec(title || '');
            return m ? parseInt(m[1], 10) : (title || '').trim();
        }

        function handleSeriesTree(zid, movie) {
            Lampa.Loading.start();
            resolveSerialTree(zid, function (tree) {
                Lampa.Loading.stop();

                if (!tree || !tree.length) { showError('UAFLIX: не вдалося розібрати список серій'); return; }

                function afterVoice(voice) {
                    var seasons = voice.folder || [];
                    if (!seasons.length) { showError('UAFLIX: сезони не знайдено'); return; }

                    function afterSeason(season) {
                        var episodes = season.folder || [];
                        if (!episodes.length) { showError('UAFLIX: серії не знайдено'); return; }

                        var seasonKey = seasonNumberFromTitle(season.title);
                        var playlist = buildPlaylist(episodes).map(function (ep) {
                            ep.timeline = timelineFor(movie, seasonKey, ep.title);
                            return ep;
                        });
                        pickEpisodeList('Серія', playlist, function (idx) {
                            playFromPlaylist(playlist, idx, movie);
                        });
                    }

                    if (seasons.length === 1) {
                        afterSeason(seasons[0]);
                    } else {
                        pickFromList('Сезон', seasons, function (idx) { afterSeason(seasons[idx]); });
                    }
                }

                if (tree.length === 1) {
                    afterVoice(tree[0]);
                } else {
                    pickFromList('Озвучення', tree, function (idx) { afterVoice(tree[idx]); });
                }
            }, function (a, b) {
                Lampa.Loading.stop();
                showError('UAFLIX: не вдалося завантажити список серій', { a: a, b: b });
            });
        }

        // 'vod' kind, series: an in-progress show without a full /serial/
        // archive. Season count comes from "Сезон N" labels harvested while
        // resolving the matched page (see resolvePageVia); episodes within
        // whichever season is chosen are discovered by probing predictable
        // URLs (title/poster only, cheap). The actual video is resolved
        // lazily per episode — eagerly only for the one about to play, and
        // via a Lampa.Player.playlist() url-function (matched to real
        // balancer plugin source, rezka.js) for the rest, so next/prev
        // resolves on demand instead of upfront.
        function handleVodSeries(picked, movie) {
            var info = picked.info;

            if (!info.series) {
                // couldn't parse season/episode from the URL — fall back to a single episode
                Lampa.Loading.start();
                resolveVod(info.zid, function (res) {
                    Lampa.Loading.stop();
                    playSingle(res.file, movie.title || movie.name || picked.candidate.title, res.poster, true, timelineFor(movie));
                }, function (a, b) {
                    Lampa.Loading.stop();
                    showError('UAFLIX: не вдалося отримати відео', { a: a, b: b });
                });
                return;
            }

            var series = info.series;
            var seasonCount = info.seasonCount || 1;

            function afterSeasonChosen(season) {
                Lampa.Loading.start();
                probeSeasonEpisodes(series.slug, season, function (episodes) {
                    Lampa.Loading.stop();
                    if (!episodes.length) { showError('UAFLIX: серії не знайдено'); return; }

                    var preselect = 0;
                    for (var i = 0; i < episodes.length; i++) {
                        if (episodes[i].season === series.season && episodes[i].episode === series.episode) { preselect = i; break; }
                    }

                    pickEpisodeList('Серія', episodes, function (idx) {
                        playVodEpisode(series.slug, episodes, idx, movie);
                    }, preselect);
                });
            }

            if (seasonCount > 1) {
                var seasons = [];
                for (var s = 1; s <= seasonCount; s++) seasons.push({ title: 'Сезон ' + s, season: s });
                pickFromList('Сезон', seasons, function (idx) { afterSeasonChosen(seasons[idx].season); });
            } else {
                afterSeasonChosen(series.season || 1);
            }
        }

        // Resolves the chosen episode eagerly (so it can start playing right
        // away), and registers the rest of the season as a lazily-resolved
        // Lampa.Player.playlist() — each entry's `url` is a function Lampa
        // calls only when the user actually navigates to it via next/prev.
        function playVodEpisode(slug, episodes, startIndex, movie) {
            var chosen = episodes[startIndex];

            Lampa.Loading.start();
            resolveEpisode(slug, chosen.season, chosen.episode, function (res) {
                Lampa.Loading.stop();

                var title = (movie.title || movie.name || '') + ' — ' + chosen.title;
                Lampa.Player.play({
                    url: viaUaProxy(res.file),
                    title: title,
                    poster: res.poster || chosen.poster || '',
                    timeline: timelineFor(movie, chosen.season, chosen.episode)
                });

                if (Lampa.Player.playlist) {
                    var playlist = episodes.map(function (ep, idx) {
                        if (idx === startIndex) {
                            return {
                                url: viaUaProxy(res.file),
                                title: ep.title,
                                poster: res.poster || ep.poster || '',
                                timeline: timelineFor(movie, ep.season, ep.episode)
                            };
                        }
                        var cell = {
                            title: ep.title,
                            poster: ep.poster || '',
                            timeline: timelineFor(movie, ep.season, ep.episode),
                            url: function (call) {
                                resolveEpisode(slug, ep.season, ep.episode, function (lazyRes) {
                                    cell.url = viaUaProxy(lazyRes.file);
                                    call();
                                }, function () {
                                    cell.url = '';
                                    call();
                                });
                            }
                        };
                        return cell;
                    });
                    Lampa.Player.playlist(playlist);
                }
            }, function (a, b) {
                Lampa.Loading.stop();
                showError('UAFLIX: не вдалося отримати відео', { a: a, b: b });
            });
        }

        function handleResolved(picked, movie) {
            // picked = {candidate, info: {url, year, kind, zid, series, episodes}}
            var info = picked.info;

            if (info.kind === 'serial') {
                handleSeriesTree(info.zid, movie);
                return;
            }

            if (picked.candidate.type === 'series') {
                handleVodSeries(picked, movie);
                return;
            }

            Lampa.Loading.start();
            resolveVod(info.zid, function (res) {
                Lampa.Loading.stop();
                playSingle(res.file, movie.title || movie.name || picked.candidate.title, res.poster, false, timelineFor(movie));
            }, function (a, b) {
                Lampa.Loading.stop();
                showError('UAFLIX: не вдалося отримати відео', { a: a, b: b });
            });
        }

        function startSearchFlow(movie) {
            var info = movieInfo(movie);
            var cacheId = String(movie.id);

            var cached = matchCache.get(cacheId);
            if (cached) {
                Lampa.Loading.start();
                resolvePage(cached.url, function (freshInfo) {
                    Lampa.Loading.stop();
                    handleResolved({ candidate: cached, info: freshInfo }, movie);
                }, function () {
                    Lampa.Loading.stop();
                    matchCache.set(cacheId, null);
                    startSearchFlow(movie); // retry a fresh search once
                });
                return;
            }

            if (!info.title) { showError('UAFLIX: немає назви для пошуку'); return; }

            Lampa.Loading.start();
            search(info.title, function (candidates) {
                Lampa.Loading.stop();

                matchMovie(info, candidates, function (result) {
                    if (result.none) {
                        showError('UAFLIX: нічого не знайдено на ' + domain());
                        return;
                    }

                    if (result.auto) {
                        matchCache.set(cacheId, result.auto.candidate);
                        handleResolved(result.auto, movie);
                        return;
                    }

                    pickCandidate(result.choices, function (picked) {
                        matchCache.set(cacheId, picked.candidate);
                        handleResolved(picked, movie);
                    });
                });
            }, function (a, b) {
                Lampa.Loading.stop();
                showError('UAFLIX: сайт недоступний (' + domain() + ')', { a: a, b: b });
            });
        }

        // ---------------------------------------------------------------
        // Button injection into the movie/series detail screen.
        // NOTE: `.full-start__button` / `.full-start-new__buttons` are the
        // class names used by Lampa's own card-action buttons at the time
        // this was written. If a Lampa update renames them, this is the
        // one place to fix.
        // ---------------------------------------------------------------

        // Lampa's default button CSS hides/collapses the label span until the
        // button is focused (a compact icon-first design shared by the built-in
        // buttons). Our button has no icon, so unfocused it looked empty —
        // force the label to always render.
        function ensureButtonStyle() {
            if ($('#uaflix-style').length) return;
            $('<style id="uaflix-style">.uaflix-btn span{display:inline !important;opacity:1 !important;width:auto !important;max-width:none !important;margin-left:.5em;}</style>').appendTo('head');
        }

        function injectButton(render, movie) {
            if (render.find('.uaflix-btn').length) return;

            ensureButtonStyle();

            var btn = $('<div class="full-start__button selector uaflix-btn"><span>UAFLIX</span></div>');
            btn.on('hover:enter', function () { startSearchFlow(movie); });

            var container = render.find('.full-start-new__buttons').eq(0);
            if (!container.length) container = render.find('.full-start__buttons').eq(0);

            if (container.length) {
                container.append(btn);
            } else {
                // Fallback: no known container found, drop it near the title so it's still reachable.
                render.find('.full-start-new__details, .full-start__title').eq(0).after(btn);
            }
        }

        Lampa.Listener.follow('full', function (event) {
            if (event.type !== 'complite') return;
            var movie = event.data && event.data.movie;
            if (!movie) return;
            injectButton(event.object.activity.render(), movie);
        });

        // ---------------------------------------------------------------
        // Settings
        // ---------------------------------------------------------------

        Lampa.SettingsApi.addComponent({
            component: 'uaflix',
            name: 'UAFLIX',
            icon: '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="currentColor"/></svg>'
        });

        Lampa.SettingsApi.addParam({
            component: 'uaflix',
            param: { name: DOMAIN_KEY, type: 'input', placeholder: DEFAULT_DOMAIN, values: '', default: DEFAULT_DOMAIN },
            field: { name: 'Домен сайту', description: 'На випадок якщо основний домен заблоковано/змінено' },
            onChange: function (value) { Lampa.Storage.set(DOMAIN_KEY, value); }
        });

        Lampa.SettingsApi.addParam({
            component: 'uaflix',
            param: { name: PROXY_KEY, type: 'input', placeholder: DEFAULT_PROXY, values: '', default: DEFAULT_PROXY },
            field: { name: 'CORS-проксі', description: 'Введи "-" щоб вимкнути проксі (звертатись напряму)' },
            onChange: function (value) { Lampa.Storage.set(PROXY_KEY, value); }
        });

        Lampa.SettingsApi.addParam({
            component: 'uaflix',
            param: { name: UA_PROXY_KEY, type: 'input', placeholder: DEFAULT_UA_PROXY, values: '', default: DEFAULT_UA_PROXY },
            field: { name: 'UA-проксі (для серіалів, що виходять)', description: 'Повільніший фолбек через український IP. "-" щоб вимкнути' },
            onChange: function (value) { Lampa.Storage.set(UA_PROXY_KEY, value); }
        });

        Lampa.SettingsApi.addParam({
            component: 'uaflix',
            param: { name: 'uaflix_clear_cache', type: 'static' },
            field: { name: 'Очистити кеш плагіна', description: 'Зіставлення фільмів та списки серій' },
            onRender: function (item) {
                item.on('hover:enter', function () {
                    matchCache.clear();
                    treeCache.clear();
                    Lampa.Noty.show('UAFLIX: кеш очищено');
                });
            }
        });
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') startPlugin();
        });
    }
})();
