## Movie Night Matcher

A full-stack web app for couples (or friends) to:

- Add movies to a shared list in two categories:
  - **Movies** (regular)
  - **Easy watching**
- Store metadata like IMDb score, runtime, genre, and plot
- Start a movie-night swipe session (Tinder-style yes/no flow)
- Get an automatic **match** when both people like the same movie

---

### Tech stack

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **Database:** SQLite (`better-sqlite3`)

---

### Project structure

- `web/` – React frontend
- `server/` – Express API + SQLite database

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

3. (Optional) Add an OMDb key to `server/.env` for auto metadata lookup:

   ```env
   OMDB_API_KEY=your_key_here
   ```

   Without this key, you can still add movie metadata manually.

4. Start frontend + backend:

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
- Database file is created at `server/data/movie-night.db`.
