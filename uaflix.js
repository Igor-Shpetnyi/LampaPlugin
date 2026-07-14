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
        // Isolated in one place: uafix.net needs no special headers (verified
        // via curl), zetvideo.net needs a *non-empty* Referer header present
        // (verified — the exact value doesn't matter). Wrapped in try/catch
        // and logged so failures are diagnosable via remote-debug console
        // instead of just showing a generic toast.
        // ---------------------------------------------------------------

        function log() {
            var args = Array.prototype.slice.call(arguments);
            args.unshift('[UAFLIX]');
            if (window.console && console.log) console.log.apply(console, args);
        }

        function rawRequest(url, onOk, onErr, headers) {
            log('request ->', url, headers ? '(with Referer)' : '');
            try {
                var network = new Lampa.Reguest();
                network.timeout(15000);

                var params = { dataType: 'text' };
                if (headers) params.headers = headers;

                network.silent(url, function (text) {
                    log('request ok <-', url, 'len=' + (text ? text.length : 0));
                    onOk(text);
                }, function (a, b) {
                    log('request FAILED <-', url, a, b);
                    if (onErr) onErr(a, b);
                }, false, params);
            } catch (e) {
                log('request THREW', url, e && e.message, e);
                if (onErr) onErr(e);
            }
        }

        function request(url, onOk, onErr) {
            rawRequest(url, onOk, onErr, null);
        }

        function requestWithReferer(url, onOk, onErr) {
            rawRequest(url, onOk, onErr, { 'Referer': baseUrl() + '/' });
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
        function resolvePage(url, onOk, onErr) {
            request(url, function (html) {
                var yearMatch = /itemprop="dateCreated" class="year">(\d{4})</.exec(html);
                var idMatch = /zetvideo\.net\/(vod|serial)\/(\d+)/.exec(html);

                if (!idMatch) {
                    onErr('no_player');
                    return;
                }

                onOk({
                    url: url,
                    year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
                    kind: idMatch[1],   // 'vod' | 'serial'
                    zid: idMatch[2]
                });
            }, onErr);
        }

        // ---------------------------------------------------------------
        // zetvideo.net parsing
        // ---------------------------------------------------------------

        // /vod/{id} -> single Playerjs config, file is a plain URL string.
        function resolveVod(id, onOk, onErr) {
            var url = 'https://zetvideo.net/vod/' + id;
            requestWithReferer(url, function (html) {
                var fileMatch = /file\s*:\s*"([^"]+)"/.exec(html);
                var posterMatch = /poster\s*:\s*"([^"]*)"/.exec(html);
                if (!fileMatch) { onErr('no_file'); return; }
                onOk({ file: fileMatch[1], poster: posterMatch ? posterMatch[1] : '' });
            }, onErr);
        }

        // /serial/{id} -> Playerjs config, file is a JSON string (voices -> seasons -> episodes).
        function resolveSerialTree(id, onOk, onErr) {
            var cached = treeCache.get(id);
            if (cached) { onOk(cached); return; }

            var url = 'https://zetvideo.net/serial/' + id;
            requestWithReferer(url, function (html) {
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

        function playSingle(file, title, poster) {
            Lampa.Player.play({
                url: file,
                title: title,
                poster: poster || ''
            });
        }

        function playFromPlaylist(playlist, startIndex, movie) {
            var item = playlist[startIndex];
            Lampa.Player.play({
                url: item.url,
                title: (movie.title || movie.name || '') + ' — ' + item.title,
                poster: item.poster || ''
            });
            if (Lampa.Player.playlist) {
                Lampa.Player.playlist(playlist.map(function (p) {
                    return { title: p.title, url: p.url, poster: p.poster };
                }), startIndex);
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

                        var playlist = buildPlaylist(episodes);
                        pickFromList('Серія', playlist, function (idx) {
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

        function handleResolved(picked, movie) {
            // picked = {candidate, info: {url, year, kind, zid}}
            var info = picked.info;

            if (info.kind === 'serial') {
                handleSeriesTree(info.zid, movie);
                return;
            }

            // 'vod' kind: single file. For series this means an in-progress
            // show without a full archive on the site — V1 just plays the
            // matched episode; full episode-by-episode browsing for this
            // case is a planned follow-up.
            Lampa.Loading.start();
            resolveVod(info.zid, function (res) {
                Lampa.Loading.stop();
                if (picked.candidate.type === 'series') {
                    showError('UAFLIX: цей серіал ще не має повного архіву на сайті, доступна лише ця серія');
                }
                playSingle(res.file, movie.title || movie.name || picked.candidate.title, res.poster);
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
            $('<style id="uaflix-style">.uaflix-btn span{opacity:1 !important;width:auto !important;max-width:none !important;margin-left:.5em;}</style>').appendTo('head');
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
            param: { name: DOMAIN_KEY, type: 'input', default: DEFAULT_DOMAIN },
            field: { name: 'Домен сайту', description: 'На випадок якщо основний домен заблоковано/змінено' },
            onChange: function (value) { Lampa.Storage.set(DOMAIN_KEY, value); }
        });

        Lampa.SettingsApi.addParam({
            component: 'uaflix',
            param: { name: 'uaflix_clear_cache', type: 'button' },
            field: { name: 'Очистити кеш плагіна', description: 'Зіставлення фільмів та списки серій' },
            onChange: function () {
                matchCache.clear();
                treeCache.clear();
                Lampa.Noty.show('UAFLIX: кеш очищено');
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
