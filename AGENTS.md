# AGENTS.md

## Cursor Cloud specific instructions

**Product:** Movie Night Matcher — a two-service full-stack app (React + Vite frontend, Node.js + Express backend) for building shared movie watchlists and running Tinder-style swipe sessions.

### Services

| Service | Command | Port |
|---|---|---|
| Frontend (Vite) | `npm run dev --prefix web` | 5173 |
| Backend (Express) | `npm run dev --prefix server` | 4000 |
| Both together | `npm run dev` (from repo root) | — |

### Key notes

- **No local database required.** Persistence is via [JSONBlob](https://jsonblob.com/) (remote). A new blob is auto-created on first backend start if `JSONBLOB_ID`/`JSONBLOB_URL` are not set in `server/.env`.
- **`server/.env` must exist** before starting the backend. Copy from `server/.env.example` if missing: `cp server/.env.example server/.env`.
- The Vite dev server proxies `/api` to `localhost:4000` (configured in `web/vite.config.js`).
- **OMDb API key is optional.** Without `OMDB_API_KEY` in `server/.env`, the "Lookup metadata from OMDb" button will fail, but movies can still be added with manual metadata.
- **Lint:** `npm run lint` runs ESLint on the `web/` package only. There is a pre-existing lint error in `web/vite.config.js` (`'process' is not defined`).
- **Build:** `npm run build` builds the frontend via Vite into `web/dist/`.
- **No automated test suite** exists in this repo; testing is manual via the UI.
