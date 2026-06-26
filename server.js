const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────
const config = {
  jellyfin: { url: (process.env.JELLYFIN_URL  || '').replace(/\/$/, ''), apiKey: process.env.JELLYFIN_API_KEY  || '' },
  radarr:   { url: (process.env.RADARR_URL    || '').replace(/\/$/, ''), apiKey: process.env.RADARR_API_KEY    || '' },
  sonarr:   { url: (process.env.SONARR_URL    || '').replace(/\/$/, ''), apiKey: process.env.SONARR_API_KEY    || '' },
  seer:     { url: (process.env.SEER_URL      || '').replace(/\/$/, ''), apiKey: process.env.SEER_API_KEY      || '' },
  pollInterval:   parseInt(process.env.POLL_INTERVAL   || '5',  10),
  screenDuration: parseInt(process.env.SCREEN_DURATION || '15', 10),
};

// ── Logger ────────────────────────────────────────────────────────
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function ts() { return new Date().toISOString(); }

function log(level, source, msg, data) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const prefix = `${ts()} [${level.padEnd(5)}] [${source}]`;
  const line = data !== undefined ? `${prefix} ${msg} ${JSON.stringify(data)}` : `${prefix} ${msg}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN')  console.warn(line);
  else console.log(line);
}

const logger = {
  debug: (src, msg, d) => log('DEBUG', src, msg, d),
  info:  (src, msg, d) => log('INFO',  src, msg, d),
  warn:  (src, msg, d) => log('WARN',  src, msg, d),
  error: (src, msg, d) => log('ERROR', src, msg, d),
};

// ── Request logging middleware ────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const lvl = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'DEBUG';
      logger[lvl.toLowerCase()]('HTTP', `${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    });
  }
  next();
});

// ── API fetch helper ──────────────────────────────────────────────
async function apiFetch(url, apiKey, source) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      timeout: 6000,
    });
    const ms = Date.now() - start;
    if (!res.ok) {
      logger.warn(source, `HTTP ${res.status} ${res.statusText} (${ms}ms)`, { url: url.replace(apiKey, '***') });
      return null;
    }
    logger.debug(source, `OK (${ms}ms)`, { url: url.split('?')[0] });
    return await res.json();
  } catch (e) {
    const ms = Date.now() - start;
    logger.warn(source, `Fetch failed after ${ms}ms: ${e.message}`);
    return null;
  }
}

// ── Jellyfin: active sessions ─────────────────────────────────────
async function getActiveSessions() {
  if (!config.jellyfin.url || !config.jellyfin.apiKey) {
    logger.warn('Jellyfin', 'Not configured — skipping session poll');
    return null;
  }

  const data = await apiFetch(
    `${config.jellyfin.url}/Sessions?ActiveWithinSeconds=30`,
    config.jellyfin.apiKey, 'Jellyfin'
  );
  if (!Array.isArray(data)) {
    logger.warn('Jellyfin', 'Sessions response was not an array');
    return null;
  }

  const playing = data.filter(s => s.NowPlayingItem);
  const session = playing.find(s => !s.PlayState?.IsPaused) || null;

  logger.debug('Jellyfin', `Sessions: ${data.length} total, ${playing.length} playing, locked=${!!session}`);

  if (!session) return null;

  const item          = session.NowPlayingItem;
  const state         = session.PlayState || {};
  const durationTicks = item.RunTimeTicks  || 0;
  const positionTicks = state.PositionTicks || 0;

  const np = {
    title: item.Type === 'Episode'
      ? `${item.SeriesName} — S${String(item.ParentIndexNumber).padStart(2,'0')}E${String(item.IndexNumber).padStart(2,'0')}`
      : item.Name,
    type:           item.Type,
    year:           item.ProductionYear,
    overview:       item.Overview || '',
    genres:         (item.Genres || []).slice(0, 3).join(' · '),
    officialRating: item.OfficialRating || '',
    communityRating:item.CommunityRating ? item.CommunityRating.toFixed(1) : null,
    durationTicks,
    positionTicks,
    durationMs:  Math.floor(durationTicks / 10000),
    positionMs:  Math.floor(positionTicks / 10000),
    progressPct: durationTicks > 0 ? Math.min(100, (positionTicks / durationTicks) * 100) : 0,
    posterUrl:   item.Id ? `${config.jellyfin.url}/Items/${item.Id}/Images/Primary?maxHeight=600&quality=90&api_key=${config.jellyfin.apiKey}` : null,
    backdropUrl: item.BackdropImageTags?.length ? `${config.jellyfin.url}/Items/${item.Id}/Images/Backdrop/0?maxWidth=1920&quality=80&api_key=${config.jellyfin.apiKey}` : null,
    userName:    session.UserName   || 'Unknown',
    deviceName:  session.DeviceName || 'Unknown Device',
    client:      session.Client     || '',
    isPaused:    !!state.IsPaused,
    jellyfin:    { itemId: item.Id },
  };

  logger.info('Jellyfin', `Now playing: "${np.title}" for ${np.userName} on ${np.deviceName} (${Math.round(np.progressPct)}%)`);
  return np;
}

// ── Jellyfin: library fallback ────────────────────────────────────
async function getJellyfinLibrary() {
  if (!config.jellyfin.url || !config.jellyfin.apiKey) return [];

  logger.debug('Jellyfin', 'Fetching library (recently added + played)');
  const fields = 'Fields=PrimaryImageAspectRatio,Overview,Genres,CommunityRating,OfficialRating,ProductionYear';
  const types  = 'IncludeItemTypes=Movie,Series&Recursive=true';

  const [added, played] = await Promise.all([
    apiFetch(`${config.jellyfin.url}/Items?SortBy=DateCreated&SortOrder=Descending&${types}&Limit=18&${fields}&api_key=${config.jellyfin.apiKey}`, config.jellyfin.apiKey, 'Jellyfin'),
    apiFetch(`${config.jellyfin.url}/Items?SortBy=DatePlayed&SortOrder=Descending&${types}&Limit=6&${fields}&Filters=IsPlayed&api_key=${config.jellyfin.apiKey}`,  config.jellyfin.apiKey, 'Jellyfin'),
  ]);

  const seen  = new Set();
  const items = [...(added?.Items || []), ...(played?.Items || [])].filter(i => {
    if (seen.has(i.Id)) return false;
    seen.add(i.Id);
    return true;
  }).slice(0, 12);

  logger.info('Jellyfin', `Library fallback: ${items.length} items`);

  return items.map(i => ({
    title:    i.Name,
    year:     i.ProductionYear || '',
    overview: i.Overview || '',
    rating:   i.CommunityRating ? i.CommunityRating.toFixed(1) : null,
    status:   'available',
    source:   'jellyfin',
    type:     i.Type === 'Series' ? 'series' : 'movie',
    posterUrl:`${config.jellyfin.url}/Items/${i.Id}/Images/Primary?maxHeight=400&quality=85&api_key=${config.jellyfin.apiKey}`,
  }));
}

// ── Radarr ────────────────────────────────────────────────────────
async function getRadarrData() {
  if (!config.radarr.url || !config.radarr.apiKey) return { queue: [], movies: [] };

  const [queue, movies] = await Promise.all([
    apiFetch(`${config.radarr.url}/api/v3/queue`,  config.radarr.apiKey, 'Radarr'),
    apiFetch(`${config.radarr.url}/api/v3/movie`,  config.radarr.apiKey, 'Radarr'),
  ]);

  const queueItems = (queue?.records || []).map(q => ({
    title: q.title, timeleft: q.timeleft,
    pct: q.size > 0 ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0,
    status: 'downloading', source: 'radarr',
    posterUrl: null,
  }));

  const recentMovies = (movies || [])
    .filter(m => m.hasFile)
    .sort((a, b) => new Date(b.added) - new Date(a.added))
    .slice(0, 12)
    .map(m => ({
      title: m.title, year: m.year, rating: null, status: 'available', source: 'radarr', type: 'movie',
      posterUrl: m.images?.find(i => i.coverType === 'poster')?.remoteUrl || null,
      radarrId: m.id,
    }));

  logger.info('Radarr', `Queue: ${queueItems.length} items, Library: ${recentMovies.length} movies`);
  return { queue: queueItems, movies: recentMovies };
}

// ── Sonarr ────────────────────────────────────────────────────────
async function getSonarrData() {
  if (!config.sonarr.url || !config.sonarr.apiKey) return { queue: [] };

  const queue = await apiFetch(`${config.sonarr.url}/api/v3/queue`, config.sonarr.apiKey, 'Sonarr');
  const queueItems = (queue?.records || []).map(q => ({
    title: q.title, timeleft: q.timeleft,
    pct: q.size > 0 ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0,
    status: 'downloading', source: 'sonarr', type: 'series', posterUrl: null,
  }));

  logger.info('Sonarr', `Queue: ${queueItems.length} items`);
  return { queue: queueItems };
}

// ── Seer ──────────────────────────────────────────────────────────
async function getSeerData(jellyfinTitle) {
  if (!config.seer.url || !config.seer.apiKey) return { requests: [], nowPlayingMeta: null };

  const [requests, search] = await Promise.all([
    apiFetch(`${config.seer.url}/api/v1/request?take=20&sort=added`, config.seer.apiKey, 'Seer'),
    jellyfinTitle
      ? apiFetch(`${config.seer.url}/api/v1/search?query=${encodeURIComponent(jellyfinTitle)}&page=1`, config.seer.apiKey, 'Seer')
      : Promise.resolve(null),
  ]);

  const requestItems = (requests?.results || []).map(r => ({
    title:    r.media?.title || r.media?.name || 'Unknown',
    year:     r.media?.releaseDate?.substring(0, 4) || r.media?.firstAirDate?.substring(0, 4) || '',
    status:   'requested', source: 'seer',
    posterUrl:r.media?.posterPath ? `https://image.tmdb.org/t/p/w300${r.media.posterPath}` : null,
    type:     r.media?.mediaType === 'tv' ? 'series' : 'movie',
    tmdbId:   r.media?.tmdbId,
  }));

  logger.info('Seer', `Requests: ${requestItems.length}${jellyfinTitle ? `, searching for "${jellyfinTitle}"` : ''}`);

  let nowPlayingMeta = null;
  if (search?.results?.length) {
    const match  = search.results[0];
    logger.debug('Seer', `Matched "${jellyfinTitle}" → "${match.title || match.name}" (${match.mediaType})`);
    const detail = await apiFetch(`${config.seer.url}/api/v1/${match.mediaType}/${match.id}`, config.seer.apiKey, 'Seer');
    if (detail) {
      nowPlayingMeta = {
        voteAverage: detail.voteAverage ? detail.voteAverage.toFixed(1) : null,
        cast: (detail.credits?.cast || []).slice(0, 5).map(c => ({
          name: c.name, character: c.character,
          profileUrl: c.profilePath ? `https://image.tmdb.org/t/p/w185${c.profilePath}` : null,
        })),
        director:   (detail.credits?.crew || []).find(c => c.job === 'Director')?.name || null,
        runtime:    detail.runtime || null,
        tagline:    detail.tagline || null,
        backdropUrl:detail.backdropPath ? `https://image.tmdb.org/t/p/original${detail.backdropPath}` : null,
        posterUrl:  detail.posterPath   ? `https://image.tmdb.org/t/p/w500${detail.posterPath}`       : null,
      };
      logger.debug('Seer', `Enriched "${jellyfinTitle}": rating=${nowPlayingMeta.voteAverage}, cast=${nowPlayingMeta.cast.length}`);
    }
  } else if (jellyfinTitle) {
    logger.warn('Seer', `No search results for "${jellyfinTitle}"`);
  }

  return { requests: requestItems, nowPlayingMeta };
}

// ── Radarr: file details for now-playing ─────────────────────────
async function getRadarrFileDetails(title, year) {
  if (!config.radarr.url || !config.radarr.apiKey) return null;

  const movies = await apiFetch(`${config.radarr.url}/api/v3/movie`, config.radarr.apiKey, 'Radarr');
  if (!Array.isArray(movies)) return null;

  const match = movies.find(m =>
    m.title.toLowerCase() === (title || '').toLowerCase() && (!year || m.year === year)
  );
  if (!match?.movieFile) {
    logger.debug('Radarr', `No file match for "${title}" (${year})`);
    return null;
  }

  const mf = match.movieFile;
  const fd = {
    resolution: mf.mediaInfo?.videoResolution || null,
    videoCodec: mf.mediaInfo?.videoCodec      || null,
    audioCodec: mf.mediaInfo?.audioCodec      || null,
    size:       mf.size ? `${(mf.size / 1e9).toFixed(1)} GB` : null,
    hdr:        mf.mediaInfo?.videoDynamicRangeType || null,
    quality:    mf.quality?.quality?.name || null,
  };
  logger.debug('Radarr', `File details for "${title}"`, fd);
  return fd;
}

// ── /api/state ────────────────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  const start = Date.now();
  try {
    const [session, radarrData, sonarrData] = await Promise.all([
      getActiveSessions(),
      getRadarrData(),
      getSonarrData(),
    ]);

    const [seerData, fileDetails] = await Promise.all([
      getSeerData(session?.title),
      session?.type === 'Movie' ? getRadarrFileDetails(session.title, session.year) : Promise.resolve(null),
    ]);

    let nowPlaying = null;
    if (session) {
      nowPlaying = { ...session, fileDetails, meta: seerData.nowPlayingMeta };
      if (seerData.nowPlayingMeta?.backdropUrl) nowPlaying.backdropUrl = seerData.nowPlayingMeta.backdropUrl;
      if (seerData.nowPlayingMeta?.posterUrl)   nowPlaying.posterUrl   = seerData.nowPlayingMeta.posterUrl;
    }

    const downloading = [...radarrData.queue, ...sonarrData.queue];
    const requested   = seerData.requests;
    let available     = radarrData.movies;

    if (!available.length && !requested.length && !downloading.length) {
      available = await getJellyfinLibrary();
    }

    let spotlight = downloading.length
      ? downloading.reduce((a, b) => (a.pct > b.pct ? a : b))
      : null;

    if (!spotlight && available.length) {
      spotlight = available.find(m => m.title !== session?.title) || available[0];
      if (spotlight) spotlight = { ...spotlight, pct: null, status: 'available' };
    }

    const ms = Date.now() - start;
    logger.info('API', `/api/state resolved in ${ms}ms — playing=${!!nowPlaying}, available=${available.length}, downloading=${downloading.length}, requested=${requested.length}`);

    res.json({
      nowPlaying, downloading, requested, available, spotlight,
      config:   { pollInterval: config.pollInterval, screenDuration: config.screenDuration },
      services: { jellyfin: !!config.jellyfin.url, radarr: !!config.radarr.url, sonarr: !!config.sonarr.url, seer: !!config.seer.url },
    });
  } catch (err) {
    logger.error('API', `/api/state failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// ── /api/config ───────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    pollInterval: config.pollInterval, screenDuration: config.screenDuration,
    services: { jellyfin: !!config.jellyfin.url, radarr: !!config.radarr.url, sonarr: !!config.sonarr.url, seer: !!config.seer.url },
  });
});

// ── Static ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const svc = (name, url) => url ? `✓ ${name}: ${url}` : `✗ ${name}: not configured`;
  console.log(`
╔══════════════════════════════════════╗
║       Postarr for Jellyfin           ║
╚══════════════════════════════════════╝
  URL:       http://localhost:${PORT}
  Log level: ${process.env.LOG_LEVEL || 'INFO'}
  Poll:      every ${config.pollInterval}s
  Screens:   ${config.screenDuration}s each

  ${svc('Jellyfin', config.jellyfin.url)}
  ${svc('Radarr',   config.radarr.url)}
  ${svc('Sonarr',   config.sonarr.url)}
  ${svc('Seer',     config.seer.url)}
`);
  logger.info('Server', `Listening on port ${PORT}`);
});
