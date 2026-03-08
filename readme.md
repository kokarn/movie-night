## Movie Night Matcher

A full-stack web app for couples (or friends) to:

- Add movies to a shared list in two categories:
  - **Movies** (regular)
  - **Easy watching**
- Store metadata like IMDb score, runtime, genre, and plot
- Start a movie-night swipe session (Tinder-style yes/no flow)
- Get an automatic **match** when both people like the same movie

---

### UI preview

#### Shared lists
![Shared lists](screenshots/01-shared-lists.png)

#### Movie night swipe
![Movie night swipe](screenshots/02-movie-night-swipe.png)

#### Match state
![Match result](screenshots/03-match.png)

---

### Tech stack

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **Persistence:** [JSONBlob](https://jsonblob.com/) (hosted JSON document store)

---

### Project structure

- `web/` – React frontend
- `server/` – Express API + JSONBlob-backed persistence

---

### Local setup

1. Install dependencies (already done once in this repo):

   ```bash
   npm install
   npm install --prefix server
   npm install --prefix web
   ```

2. Configure backend environment:

   ```bash
   cp server/.env.example server/.env
   ```

3. Configure JSONBlob persistence in `server/.env`:

   - Option A (recommended): set an existing blob id

     ```env
     JSONBLOB_ID=your_blob_id
     ```

   - Option B: set full blob URL

     ```env
     JSONBLOB_URL=https://jsonblob.com/api/jsonBlob/your_blob_id
     ```

   If neither value is set, the server auto-creates a new blob on first start and logs the URL/id to reuse.

4. (Optional) Add an OMDb key to `server/.env` for auto metadata lookup:

   ```env
   OMDB_API_KEY=your_key_here
   ```

   Without this key, you can still add movie metadata manually.

5. Start frontend + backend:

   ```bash
   npm run dev
   ```

   - Frontend: `http://localhost:5173`
   - Backend API: `http://localhost:4000`

---

### Core flows

#### 1. Build shared lists
- Choose who is adding a movie
- Pick category (`Movies` or `Easy watching`)
- Enter title and (optional) auto-fetch metadata from OMDb
- Save movie into the selected shared category

#### 2. Run movie night swipes
- Start a new session in one category
- Pass the device between users for each card
- Swipe left/right (No/Yes)
- If both users swipe right on the same movie, it appears in **Matches**

---

### API quick reference

- `GET /api/users`
- `POST /api/users`
- `GET /api/library`
- `POST /api/library`
- `POST /api/movies/lookup`
- `POST /api/sessions/start`
- `GET /api/sessions/:sessionId/state`
- `POST /api/sessions/:sessionId/swipe`
- `GET /api/sessions/:sessionId/matches`

---

### Notes

- Default seeded users are `"You"` and `"Partner"` (configurable via `DEFAULT_USERS`).
- Data is stored remotely in JSONBlob (no local DB process required).

---

### GitHub Pages deployment (production + PR previews)

- This repo includes:
  - `.github/workflows/deploy-pages.yml` to deploy the main `web/` app on pushes to `main`.
  - `.github/workflows/deploy-pr-preview.yml` to deploy/update a preview for each PR and remove it when the PR is closed.
- In repository settings:
  1. Go to **Settings → Pages → Build and deployment** and set **Source** to **Deploy from a branch**.
  2. Set branch to **`gh-pages`** and folder to **`/ (root)`**.
  3. Go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**.
- URL formats:
  - Production: `https://kokarn.github.io/movie-night/`
  - PR previews: `https://kokarn.github.io/movie-night/pr-preview/pr-<number>/`
- For API calls in deployed builds, set a repository variable named `VITE_API_BASE_URL` (for example your deployed backend URL).  
  If unset, the frontend uses relative `/api` paths (works for local dev with the Vite proxy).

---

### Backend container publish (GHCR)

- This repo includes a workflow at `.github/workflows/push-backend-ghcr.yml` that builds and pushes the backend image to GitHub Container Registry (GHCR) on every push.
- Image name:
  - `ghcr.io/<owner>/<repo>-backend`
- Published tags:
  - `sha-<commit-sha>`
  - `<branch-name>`
  - `latest` (default branch only)
