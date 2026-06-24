const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config from env ──────────────────────────────────────────────
const config = {
  jellyfin: {
    url: (process.env.JELLYFIN_URL || '').replace(/\/$/, ''),
    apiKey: process.env.JELLYFIN_API_KEY || '',
  },
  radarr: {
    url: (process.env.RADARR_URL || '').replace(/\/$/, ''),
    apiKey: process.env.RADARR_API_KEY || '',
  },
  sonarr: {
    url: (process.env.SONARR_URL || '').replace(/\/$/, ''),
    apiKey: process.env.SONARR_API_KEY || '',
  },
  seer: {
    url: (process.env.SEER_URL || '').replace(/\/$/, ''),
    apiKey: process.env.SEER_API_KEY || '',
  },
  pollInterval: parseInt(process.env.POLL_INTERVAL || '5', 10),
  screenDuration: parseInt(process.env.SCREEN_DURATION || '15', 10),
};

// ── Helpers ──────────────────────────────────────────────────────
async function apiFetch(url, apiKey, label) {
  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      timeout: 5000,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[${label}] fetch error:`, e.message);
    return null;
  }
}

// ── Jellyfin: active sessions ─────────────────────────────────────
async function getActiveSessions() {
  if (!config.jellyfin.url || !config.jellyfin.apiKey) return null;
  const data = await apiFetch(
    `${config.jellyfin.url}/Sessions?ActiveWithinSeconds=30`,
    config.jellyfin.apiKey,
    'Jellyfin'
  );
  if (!Array.isArray(data)) return null;

  // Find first session with active playback
  const session = data.find(s => s.NowPlayingItem && !s.PlayState?.IsPaused);
  if (!session) return null;

  const item = session.NowPlayingItem;
  const state = session.PlayState || {};
  const durationTicks = item.RunTimeTicks || 0;
  const positionTicks = state.PositionTicks || 0;

  return {
    title: item.Type === 'Episode'
      ? `${item.SeriesName} — S${String(item.ParentIndexNumber).padStart(2,'0')}E${String(item.IndexNumber).padStart(2,'0')}`
      : item.Name,
    type: item.Type, // Movie | Episode
    year: item.ProductionYear,
    overview: item.Overview || '',
    genres: (item.Genres || []).slice(0, 3).join(' · '),
    officialRating: item.OfficialRating || '',
    communityRating: item.CommunityRating ? item.CommunityRating.toFixed(1) : null,
    durationTicks,
    positionTicks,
    durationMs: Math.floor(durationTicks / 10000),
    positionMs: Math.floor(positionTicks / 10000),
    progressPct: durationTicks > 0 ? Math.min(100, (positionTicks / durationTicks) * 100) : 0,
    posterUrl: item.Id
      ? `${config.jellyfin.url}/Items/${item.Id}/Images/Primary?maxHeight=600&quality=90&api_key=${config.jellyfin.apiKey}`
      : null,
    backdropUrl: (item.BackdropImageTags?.length)
      ? `${config.jellyfin.url}/Items/${item.Id}/Images/Backdrop/0?maxWidth=1920&quality=80&api_key=${config.jellyfin.apiKey}`
      : null,
    userName: session.UserName || 'Unknown',
    deviceName: session.DeviceName || 'Unknown Device',
    client: session.Client || '',
    isPaused: !!state.IsPaused,
    jellyfin: { itemId: item.Id },
  };
}

// ── Radarr: queue + movie details ────────────────────────────────
async function getRadarrData() {
  if (!config.radarr.url || !config.radarr.apiKey) return { queue: [], movies: [] };

  const [queue, movies] = await Promise.all([
    apiFetch(`${config.radarr.url}/api/v3/queue`, config.radarr.apiKey, 'Radarr'),
    apiFetch(`${config.radarr.url}/api/v3/movie`, config.radarr.apiKey, 'Radarr'),
  ]);

  const queueItems = (queue?.records || []).map(q => ({
    title: q.title,
    timeleft: q.timeleft,
    pct: q.size > 0 ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0,
    status: 'downloading',
    source: 'radarr',
  }));

  const recentMovies = (movies || [])
    .filter(m => m.hasFile)
    .sort((a, b) => new Date(b.added) - new Date(a.added))
    .slice(0, 12)
    .map(m => ({
      title: m.title,
      year: m.year,
      imdbRating: null,
      status: 'available',
      source: 'radarr',
      posterUrl: m.images?.find(i => i.coverType === 'poster')?.remoteUrl || null,
      radarrId: m.id,
    }));

  return { queue: queueItems, movies: recentMovies };
}

// ── Sonarr: queue ────────────────────────────────────────────────
async function getSonarrData() {
  if (!config.sonarr.url || !config.sonarr.apiKey) return { queue: [] };

  const queue = await apiFetch(`${config.sonarr.url}/api/v3/queue`, config.sonarr.apiKey, 'Sonarr');
  const queueItems = (queue?.records || []).map(q => ({
    title: q.title,
    timeleft: q.timeleft,
    pct: q.size > 0 ? Math.round(((q.size - q.sizeleft) / q.size) * 100) : 0,
    status: 'downloading',
    source: 'sonarr',
  }));

  return { queue: queueItems };
}

// ── Seer: requests + movie details ───────────────
async function getSeerData(jellyfinTitle) {
  if (!config.seer.url || !config.seer.apiKey) return { requests: [], spotlight: null };

  const [requests, search] = await Promise.all([
    apiFetch(`${config.seer.url}/api/v1/request?take=20&sort=added`, config.seer.apiKey, 'Seer'),
    jellyfinTitle
      ? apiFetch(`${config.seer.url}/api/v1/search?query=${encodeURIComponent(jellyfinTitle)}&page=1`, config.seer.apiKey, 'Seer')
      : Promise.resolve(null),
  ]);

  const requestItems = (requests?.results || []).map(r => ({
    title: r.media?.title || r.media?.name || 'Unknown',
    year: r.media?.releaseDate?.substring(0, 4) || r.media?.firstAirDate?.substring(0, 4) || '',
    status: 'requested',
    source: 'seer',
    posterUrl: r.media?.posterPath
      ? `https://image.tmdb.org/t/p/w300${r.media.posterPath}`
      : null,
    tmdbId: r.media?.tmdbId,
  }));

  // Enrich now-playing with Seer metadata (ratings, cast, etc.)
  let nowPlayingMeta = null;
  if (search?.results?.length) {
    const match = search.results[0];
    const detail = await apiFetch(
      `${config.seer.url}/api/v1/${match.mediaType}/${match.id}`,
      config.seer.apiKey,
      'Seer'
    );
    if (detail) {
      nowPlayingMeta = {
        rtRating: detail.relatedVideos ? null : null, // RT not always available
        imdbRating: detail.externalIds?.imdbId ? null : null,
        voteAverage: detail.voteAverage ? detail.voteAverage.toFixed(1) : null,
        cast: (detail.credits?.cast || []).slice(0, 5).map(c => ({
          name: c.name,
          character: c.character,
          profileUrl: c.profilePath ? `https://image.tmdb.org/t/p/w185${c.profilePath}` : null,
        })),
        director: (detail.credits?.crew || []).find(c => c.job === 'Director')?.name || null,
        runtime: detail.runtime || null,
        tagline: detail.tagline || null,
        backdropUrl: detail.backdropPath ? `https://image.tmdb.org/t/p/original${detail.backdropPath}` : null,
        posterUrl: detail.posterPath ? `https://image.tmdb.org/t/p/w500${detail.posterPath}` : null,
      };
    }
  }

  return { requests: requestItems, nowPlayingMeta };
}

// ── Radarr: file details for currently playing movie ─────────────
async function getRadarrFileDetails(title, year) {
  if (!config.radarr.url || !config.radarr.apiKey) return null;
  const movies = await apiFetch(`${config.radarr.url}/api/v3/movie`, config.radarr.apiKey, 'Radarr');
  if (!Array.isArray(movies)) return null;

  const match = movies.find(m =>
    m.title.toLowerCase() === (title || '').toLowerCase() &&
    (!year || m.year === year)
  );
  if (!match?.movieFile) return null;

  const mf = match.movieFile;
  return {
    resolution: mf.mediaInfo?.videoResolution || null,
    videoCodec: mf.mediaInfo?.videoCodec || null,
    audioCodec: mf.mediaInfo?.audioCodec || null,
    audioChannels: mf.mediaInfo?.audioChannels || null,
    size: mf.size ? `${(mf.size / 1e9).toFixed(1)} GB` : null,
    hdr: mf.mediaInfo?.videoDynamicRangeType || null,
    quality: mf.quality?.quality?.name || null,
  };
}

// ── Combined API endpoint ─────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  try {
    const [session, radarrData, sonarrData] = await Promise.all([
      getActiveSessions(),
      getRadarrData(),
      getSonarrData(),
    ]);

    // Enrich now-playing in parallel
    const [seerData, fileDetails] = await Promise.all([
      getSeerData(session?.title),
      session?.type === 'Movie'
        ? getRadarrFileDetails(session.title, session.year)
        : Promise.resolve(null),
    ]);

    // Merge now-playing metadata
    let nowPlaying = null;
    if (session) {
      nowPlaying = {
        ...session,
        fileDetails,
        meta: seerData.nowPlayingMeta,
      };
      // Prefer TMDB backdrop over Jellyfin if available
      if (seerData.nowPlayingMeta?.backdropUrl) {
        nowPlaying.backdropUrl = seerData.nowPlayingMeta.backdropUrl;
      }
      if (seerData.nowPlayingMeta?.posterUrl) {
        nowPlaying.posterUrl = seerData.nowPlayingMeta.posterUrl;
      }
    }

    // Build upcoming list: radarr queue + requests, deduplicated
    const downloading = [...radarrData.queue, ...sonarrData.queue];
    const requested = seerData.requests;
    const available = radarrData.movies;

    // Spotlight: pick highest-progress downloading item
    const spotlight = downloading.length > 0
      ? downloading.reduce((a, b) => (a.pct > b.pct ? a : b))
      : null;

    res.json({
      nowPlaying,
      downloading,
      requested,
      available,
      spotlight,
      config: {
        pollInterval: config.pollInterval,
        screenDuration: config.screenDuration,
      },
      services: {
        jellyfin: !!config.jellyfin.url,
        radarr: !!config.radarr.url,
        sonarr: !!config.sonarr.url,
        seer: !!config.seer.url,
      },
    });
  } catch (err) {
    console.error('[API] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Config endpoint (read-only, no secrets) ───────────────────────
app.get('/api/config', (req, res) => {
  res.json({
    pollInterval: config.pollInterval,
    screenDuration: config.screenDuration,
    services: {
      jellyfin: !!config.jellyfin.url,
      radarr: !!config.radarr.url,
      sonarr: !!config.sonarr.url,
      seer: !!config.seer.url,
    },
  });
});

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎬 Postarr for Jellyfin`);
  console.log(`   Running at http://localhost:${PORT}`);
  console.log(`   Jellyfin: ${config.jellyfin.url || '⚠️  not configured'}`);
  console.log(`   Radarr:   ${config.radarr.url || '— not configured'}`);
  console.log(`   Sonarr:   ${config.sonarr.url || '— not configured'}`);
  console.log(`   Seer:${config.seer.url || '— not configured'}`);
  console.log(`   Poll:     every ${config.pollInterval}s`);
  console.log(`   Screens:  ${config.screenDuration}s each\n`);
});
