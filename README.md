# Postarr for Jellyfin

A cinematic now-playing display for Jellyfin — with optional Radarr, Sonarr, and Overseerr/Jellyseerr integration. Open it in a browser on any screen and it automatically rotates between what's playing, what's coming up, and a spotlight on your next download.


---

## Screens

| Screen | Description |
|--------|-------------|
| **Now Playing** | Full cinematic view — poster, blurred backdrop, progress bar, who's watching, ratings, file info, cast |
| **Upcoming** | Grid of your library, Radarr queue, and Jellyseerr requests with status badges |
| **Spotlight** | Hero view for the highest-progress downloading item |
| **Idle** | Minimal clock when nothing is playing |

The display **locks to Now Playing** whenever someone is actively watching, and returns to rotation when playback stops.

---

## Quick Start (Docker)

The image is published automatically to GitHub Container Registry on every push to `main`.

```bash
# 1. Grab the env template
curl -o .env https://raw.githubusercontent.com/NerdsCorp/Postarr-For-Jellyfin/main/.env.example
nano .env   # fill in your keys

# 2. Pull and run
docker run -d \
  --name postarr \
  --env-file .env \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/nerdscorp/postarr-for-jellyfin:latest

# 3. Open in your browser
open http://localhost:3000
```

Or with Docker Compose:

```bash
curl -o docker-compose.yml https://raw.githubusercontent.com/NerdsCorp/Postarr-For-Jellyfin/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/NerdsCorp/Postarr-For-Jellyfin/main/.env.example
nano .env
docker compose up -d
```

### Supported platforms
- `linux/amd64` — Intel / AMD
- `linux/arm64` — Raspberry Pi 4/5, Apple Silicon

---

## Configuration

Edit `.env` (copy from `.env.example`):

```env
# Required
JELLYFIN_URL=http://192.168.1.100:8096
JELLYFIN_API_KEY=your_key_here

# Optional — adds queue + file details
RADARR_URL=http://192.168.1.100:7878
RADARR_API_KEY=your_key_here

# Optional — adds TV queue
SONARR_URL=http://192.168.1.100:8989
SONARR_API_KEY=your_key_here

# Optional — adds ratings, cast, requests
OVERSEERR_URL=http://192.168.1.100:5055
OVERSEERR_API_KEY=your_key_here

# Timing
POLL_INTERVAL=5       # seconds between Jellyfin polls
SCREEN_DURATION=15    # seconds per screen in rotation
```

### Getting API keys

- **Jellyfin**: Dashboard → API Keys → + Add Key
- **Radarr / Sonarr**: Settings → General → API Key
- **Overseerr / Jellyseerr**: Settings → General → API Key

---

## What each service adds

| Service | What it contributes |
|---------|-------------------|
| Jellyfin | Now playing, who's watching, device, progress, community rating |
| Radarr | File resolution, codec, HDR type, audio, file size, download queue |
| Sonarr | TV download queue |
| Overseerr / Jellyseerr | Cast, director, RT/IMDb ratings, requests list |

All integrations are optional — Postarr works with just Jellyfin.

---

## Run without Docker

```bash
npm install
cp .env.example .env
# edit .env
node server.js
```

Requires Node.js 18+.

---

## License

MIT
