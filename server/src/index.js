const cors = require("cors");
const Database = require("better-sqlite3");
const dotenv = require("dotenv");
const express = require("express");
const fs = require("fs");
const path = require("path");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);

const dataDir = path.resolve(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "movie-night.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS movies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    year TEXT,
    imdb_id TEXT UNIQUE,
    imdb_rating REAL,
    runtime_minutes INTEGER,
    poster_url TEXT,
    genre TEXT,
    plot TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS list_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (category IN ('easy', 'regular')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, movie_id, category)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL CHECK (category IN ('easy', 'regular')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_swipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    liked INTEGER NOT NULL CHECK (liked IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, user_id, movie_id)
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    movie_id INTEGER NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, movie_id)
  );
`);

const seedUsers = (process.env.DEFAULT_USERS || "You,Partner")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const insertUser = db.prepare("INSERT OR IGNORE INTO users (name) VALUES (?)");
for (const name of seedUsers) {
  insertUser.run(name);
}

app.use(cors());
app.use(express.json());

const normalizeCategory = (category) =>
  category === "easy" || category === "easy-watching" ? "easy" : "regular";

const parseRuntimeMinutes = (runtimeValue) => {
  if (runtimeValue === null || runtimeValue === undefined) {
    return null;
  }
  if (typeof runtimeValue === "number") {
    return Number.isFinite(runtimeValue) ? Math.max(Math.round(runtimeValue), 0) : null;
  }

  const match = String(runtimeValue).match(/(\d+)/);
  if (!match) {
    return null;
  }

  const minutes = Number(match[1]);
  return Number.isFinite(minutes) ? minutes : null;
};

const movieQueryByCategory = `
  SELECT
    m.id,
    m.title,
    m.year,
    m.imdb_id AS imdbId,
    m.imdb_rating AS imdbRating,
    m.runtime_minutes AS runtimeMinutes,
    m.poster_url AS posterUrl,
    m.genre,
    m.plot,
    le.category,
    GROUP_CONCAT(DISTINCT u.name) AS addedBy,
    COUNT(le.id) AS addedCount
  FROM list_entries le
  JOIN movies m ON m.id = le.movie_id
  JOIN users u ON u.id = le.user_id
  WHERE le.category = ?
  GROUP BY m.id, le.category
  ORDER BY addedCount DESC, m.title COLLATE NOCASE ASC
`;

const mapMovieRow = (row) => ({
  id: row.id,
  title: row.title,
  year: row.year,
  imdbId: row.imdbId || null,
  imdbRating: row.imdbRating === null ? null : Number(row.imdbRating),
  runtimeMinutes: row.runtimeMinutes === null ? null : Number(row.runtimeMinutes),
  posterUrl: row.posterUrl || null,
  genre: row.genre || null,
  plot: row.plot || null,
  category: row.category || null,
  addedBy: row.addedBy ? row.addedBy.split(",") : [],
  addedCount: row.addedCount === undefined ? 0 : Number(row.addedCount),
});

const getSessionState = (sessionId) => {
  const session = db
    .prepare("SELECT id, category, created_at AS createdAt FROM sessions WHERE id = ?")
    .get(sessionId);

  if (!session) {
    return null;
  }

  const users = db.prepare("SELECT id, name FROM users ORDER BY id ASC").all();
  const queueRows = db.prepare(movieQueryByCategory).all(session.category);
  const swipeRows = db
    .prepare(
      `
        SELECT
          user_id AS userId,
          movie_id AS movieId,
          liked
        FROM session_swipes
        WHERE session_id = ?
      `,
    )
    .all(sessionId);
  const matchRows = db
    .prepare("SELECT movie_id AS movieId FROM matches WHERE session_id = ?")
    .all(sessionId);
  const matches = db
    .prepare(
      `
        SELECT
          m.id,
          m.title,
          m.year,
          m.imdb_id AS imdbId,
          m.imdb_rating AS imdbRating,
          m.runtime_minutes AS runtimeMinutes,
          m.poster_url AS posterUrl,
          m.genre,
          m.plot
        FROM matches mt
        JOIN movies m ON m.id = mt.movie_id
        WHERE mt.session_id = ?
        ORDER BY mt.created_at DESC
      `,
    )
    .all(sessionId)
    .map(mapMovieRow);

  const swipeMap = {};
  for (const swipe of swipeRows) {
    if (!swipeMap[swipe.movieId]) {
      swipeMap[swipe.movieId] = {};
    }
    swipeMap[swipe.movieId][swipe.userId] = Boolean(swipe.liked);
  }

  const matchedMovieIds = new Set(matchRows.map((row) => row.movieId));
  const queue = queueRows.map((row) => ({
    ...mapMovieRow(row),
    swipes: swipeMap[row.id] || {},
    matched: matchedMovieIds.has(row.id),
  }));

  return {
    session,
    users,
    queue,
    matches,
  };
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/users", (_req, res) => {
  const users = db.prepare("SELECT id, name FROM users ORDER BY id ASC").all();
  res.json(users);
});

app.post("/api/users", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (name.length > 40) {
    return res.status(400).json({ error: "Name must be 40 characters or fewer." });
  }

  try {
    const result = db.prepare("INSERT INTO users (name) VALUES (?)").run(name);
    const user = db.prepare("SELECT id, name FROM users WHERE id = ?").get(result.lastInsertRowid);
    return res.status(201).json(user);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That user already exists." });
    }
    return res.status(500).json({ error: "Unable to create user." });
  }
});

app.get("/api/library", (req, res) => {
  const category = req.query.category ? normalizeCategory(req.query.category) : null;

  let sql = `
    SELECT
      m.id,
      m.title,
      m.year,
      m.imdb_id AS imdbId,
      m.imdb_rating AS imdbRating,
      m.runtime_minutes AS runtimeMinutes,
      m.poster_url AS posterUrl,
      m.genre,
      m.plot,
      le.category,
      GROUP_CONCAT(DISTINCT u.name) AS addedBy,
      COUNT(le.id) AS addedCount
    FROM list_entries le
    JOIN movies m ON m.id = le.movie_id
    JOIN users u ON u.id = le.user_id
  `;
  const params = [];
  if (category) {
    sql += " WHERE le.category = ?";
    params.push(category);
  }
  sql += " GROUP BY m.id, le.category ORDER BY le.category ASC, addedCount DESC, m.title COLLATE NOCASE ASC";

  const rows = db.prepare(sql).all(...params).map(mapMovieRow);
  res.json(rows);
});

app.post("/api/movies/lookup", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (!title) {
    return res.status(400).json({ error: "Title is required." });
  }

  if (!process.env.OMDB_API_KEY) {
    return res.status(400).json({
      error:
        "OMDB_API_KEY is not configured. Add it to server/.env to use metadata lookup.",
    });
  }

  try {
    const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(process.env.OMDB_API_KEY)}&t=${encodeURIComponent(title)}&type=movie`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(502).json({ error: "Could not reach OMDb right now." });
    }

    const payload = await response.json();
    if (payload.Response === "False") {
      return res.status(404).json({ error: payload.Error || "Movie not found." });
    }

    return res.json({
      title: payload.Title || title,
      year: payload.Year && payload.Year !== "N/A" ? payload.Year : null,
      imdbId: payload.imdbID && payload.imdbID !== "N/A" ? payload.imdbID : null,
      imdbRating:
        payload.imdbRating && payload.imdbRating !== "N/A" ? Number(payload.imdbRating) : null,
      runtimeMinutes: parseRuntimeMinutes(payload.Runtime),
      posterUrl: payload.Poster && payload.Poster !== "N/A" ? payload.Poster : null,
      genre: payload.Genre && payload.Genre !== "N/A" ? payload.Genre : null,
      plot: payload.Plot && payload.Plot !== "N/A" ? payload.Plot : null,
    });
  } catch (_error) {
    return res.status(500).json({ error: "Lookup failed. Please try again." });
  }
});

app.post("/api/library", (req, res) => {
  const userId = Number(req.body?.userId);
  const category = normalizeCategory(req.body?.category);
  const title = String(req.body?.title || "").trim();

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "A valid user is required." });
  }
  if (!title) {
    return res.status(400).json({ error: "Movie title is required." });
  }

  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  const year = req.body?.year ? String(req.body.year).trim() : null;
  const imdbId = req.body?.imdbId ? String(req.body.imdbId).trim() : null;
  const imdbRating =
    req.body?.imdbRating === "" || req.body?.imdbRating === null || req.body?.imdbRating === undefined
      ? null
      : Number(req.body.imdbRating);
  const runtimeMinutes = parseRuntimeMinutes(req.body?.runtimeMinutes);
  const posterUrl = req.body?.posterUrl ? String(req.body.posterUrl).trim() : null;
  const genre = req.body?.genre ? String(req.body.genre).trim() : null;
  const plot = req.body?.plot ? String(req.body.plot).trim() : null;

  const insertMovie = db.prepare(
    `
      INSERT INTO movies (
        title,
        year,
        imdb_id,
        imdb_rating,
        runtime_minutes,
        poster_url,
        genre,
        plot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const updateMovie = db.prepare(
    `
      UPDATE movies
      SET
        title = ?,
        year = ?,
        imdb_rating = ?,
        runtime_minutes = ?,
        poster_url = ?,
        genre = ?,
        plot = ?
      WHERE id = ?
    `,
  );
  const getMovieByImdb = db.prepare("SELECT id FROM movies WHERE imdb_id = ?");
  const getMovieByTitleYear = db.prepare(
    `
      SELECT id
      FROM movies
      WHERE LOWER(title) = LOWER(?)
      AND COALESCE(year, '') = COALESCE(?, '')
      LIMIT 1
    `,
  );
  const linkMovie = db.prepare(
    "INSERT OR IGNORE INTO list_entries (user_id, movie_id, category) VALUES (?, ?, ?)",
  );
  const getLibraryMovie = db.prepare(
    `
      SELECT
        m.id,
        m.title,
        m.year,
        m.imdb_id AS imdbId,
        m.imdb_rating AS imdbRating,
        m.runtime_minutes AS runtimeMinutes,
        m.poster_url AS posterUrl,
        m.genre,
        m.plot,
        le.category,
        GROUP_CONCAT(DISTINCT u.name) AS addedBy,
        COUNT(le.id) AS addedCount
      FROM movies m
      JOIN list_entries le ON le.movie_id = m.id
      JOIN users u ON u.id = le.user_id
      WHERE m.id = ? AND le.category = ?
      GROUP BY m.id, le.category
    `,
  );

  const transaction = db.transaction(() => {
    let movieId = null;

    if (imdbId) {
      const existing = getMovieByImdb.get(imdbId);
      if (existing) {
        movieId = existing.id;
        updateMovie.run(
          title,
          year,
          Number.isFinite(imdbRating) ? imdbRating : null,
          runtimeMinutes,
          posterUrl,
          genre,
          plot,
          movieId,
        );
      } else {
        const result = insertMovie.run(
          title,
          year,
          imdbId,
          Number.isFinite(imdbRating) ? imdbRating : null,
          runtimeMinutes,
          posterUrl,
          genre,
          plot,
        );
        movieId = result.lastInsertRowid;
      }
    } else {
      const existing = getMovieByTitleYear.get(title, year);
      if (existing) {
        movieId = existing.id;
      } else {
        const result = insertMovie.run(
          title,
          year,
          null,
          Number.isFinite(imdbRating) ? imdbRating : null,
          runtimeMinutes,
          posterUrl,
          genre,
          plot,
        );
        movieId = result.lastInsertRowid;
      }
    }

    const linkResult = linkMovie.run(userId, movieId, category);
    const movie = getLibraryMovie.get(movieId, category);
    return {
      movie: movie ? mapMovieRow(movie) : null,
      alreadyInList: linkResult.changes === 0,
    };
  });

  try {
    const result = transaction();
    return res.status(201).json(result);
  } catch (_error) {
    return res.status(500).json({ error: "Could not add this movie to your list." });
  }
});

app.post("/api/sessions/start", (req, res) => {
  const category = normalizeCategory(req.body?.category);
  const result = db.prepare("INSERT INTO sessions (category) VALUES (?)").run(category);
  const state = getSessionState(result.lastInsertRowid);
  res.status(201).json(state);
});

app.get("/api/sessions/:sessionId/state", (req, res) => {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: "Invalid session id." });
  }

  const state = getSessionState(sessionId);
  if (!state) {
    return res.status(404).json({ error: "Session not found." });
  }

  return res.json(state);
});

app.post("/api/sessions/:sessionId/swipe", (req, res) => {
  const sessionId = Number(req.params.sessionId);
  const userId = Number(req.body?.userId);
  const movieId = Number(req.body?.movieId);
  const liked = Boolean(req.body?.liked);

  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: "Invalid session id." });
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "A valid user is required." });
  }
  if (!Number.isInteger(movieId) || movieId <= 0) {
    return res.status(400).json({ error: "A valid movie is required." });
  }

  const session = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  const user = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  db.prepare(
    `
      INSERT INTO session_swipes (
        session_id,
        user_id,
        movie_id,
        liked
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id, user_id, movie_id)
      DO UPDATE SET liked = excluded.liked, created_at = CURRENT_TIMESTAMP
    `,
  ).run(sessionId, userId, movieId, liked ? 1 : 0);

  const totalUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const yesCount = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM session_swipes
        WHERE session_id = ? AND movie_id = ? AND liked = 1
      `,
    )
    .get(sessionId, movieId).count;

  let newlyMatched = false;
  if (totalUsers > 0 && yesCount === totalUsers) {
    const matchInsert = db
      .prepare("INSERT OR IGNORE INTO matches (session_id, movie_id) VALUES (?, ?)")
      .run(sessionId, movieId);
    newlyMatched = matchInsert.changes > 0;
  }

  const state = getSessionState(sessionId);
  return res.json({
    matched: newlyMatched,
    state,
  });
});

app.get("/api/sessions/:sessionId/matches", (req, res) => {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: "Invalid session id." });
  }

  const rows = db
    .prepare(
      `
        SELECT
          m.id,
          m.title,
          m.year,
          m.imdb_id AS imdbId,
          m.imdb_rating AS imdbRating,
          m.runtime_minutes AS runtimeMinutes,
          m.poster_url AS posterUrl,
          m.genre,
          m.plot
        FROM matches mt
        JOIN movies m ON m.id = mt.movie_id
        WHERE mt.session_id = ?
        ORDER BY mt.created_at DESC
      `,
    )
    .all(sessionId)
    .map(mapMovieRow);

  res.json(rows);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Movie Night Matcher API running on http://localhost:${PORT}`);
});
