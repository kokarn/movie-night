const cors = require("cors");
const dotenv = require("dotenv");
const express = require("express");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JSONBLOB_API_ROOT = (process.env.JSONBLOB_API_ROOT || "https://jsonblob.com/api/jsonBlob").replace(
  /\/$/,
  "",
);

const seedUsers = (process.env.DEFAULT_USERS || "You,Partner")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

let blobUrl = null;
let storeCache = null;
let cacheUpdatedAt = 0;
let mutationQueue = Promise.resolve();

const READ_REFRESH_MS = 5000;

const nowIso = () => new Date().toISOString();

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

const clone = (value) => structuredClone(value);

const createInitialStore = (users) => {
  const uniqueNames = Array.from(new Set(users.map((name) => name.trim()).filter(Boolean)));
  const seededUsers = uniqueNames.map((name, index) => ({
    id: index + 1,
    name,
    createdAt: nowIso(),
  }));

  return {
    version: 1,
    nextIds: {
      user: seededUsers.length + 1,
      movie: 1,
      listEntry: 1,
      session: 1,
      sessionSwipe: 1,
      match: 1,
    },
    users: seededUsers,
    movies: [],
    listEntries: [],
    sessions: [],
    sessionSwipes: [],
    matches: [],
  };
};

const sanitizeStore = (rawStore) => {
  const empty = createInitialStore(seedUsers);
  if (!rawStore || typeof rawStore !== "object") {
    return empty;
  }

  const nextIds = {
    ...empty.nextIds,
    ...(rawStore.nextIds && typeof rawStore.nextIds === "object" ? rawStore.nextIds : {}),
  };

  return {
    version: Number(rawStore.version) || 1,
    nextIds: {
      user: Number(nextIds.user) || empty.nextIds.user,
      movie: Number(nextIds.movie) || empty.nextIds.movie,
      listEntry: Number(nextIds.listEntry) || empty.nextIds.listEntry,
      session: Number(nextIds.session) || empty.nextIds.session,
      sessionSwipe: Number(nextIds.sessionSwipe) || empty.nextIds.sessionSwipe,
      match: Number(nextIds.match) || empty.nextIds.match,
    },
    users: Array.isArray(rawStore.users) ? rawStore.users : [],
    movies: Array.isArray(rawStore.movies) ? rawStore.movies : [],
    listEntries: Array.isArray(rawStore.listEntries) ? rawStore.listEntries : [],
    sessions: Array.isArray(rawStore.sessions) ? rawStore.sessions : [],
    sessionSwipes: Array.isArray(rawStore.sessionSwipes) ? rawStore.sessionSwipes : [],
    matches: Array.isArray(rawStore.matches) ? rawStore.matches : [],
  };
};

const resolveConfiguredBlobUrl = () => {
  if (process.env.JSONBLOB_URL?.trim()) {
    return process.env.JSONBLOB_URL.trim();
  }
  if (process.env.JSONBLOB_ID?.trim()) {
    return `${JSONBLOB_API_ROOT}/${process.env.JSONBLOB_ID.trim()}`;
  }
  return null;
};

const requestJsonBlob = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`JSONBlob request failed (${response.status}): ${text || response.statusText}`);
  }
  return response;
};

const createBlob = async (initialStore) => {
  const response = await requestJsonBlob(JSONBLOB_API_ROOT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(initialStore),
  });

  const location = response.headers.get("Location") || response.headers.get("location");
  if (!location) {
    throw new Error("JSONBlob did not return a Location header.");
  }

  if (location.startsWith("http://") || location.startsWith("https://")) {
    return location;
  }
  return `https://jsonblob.com${location}`;
};

const fetchStoreFromBlob = async () => {
  const response = await requestJsonBlob(blobUrl, {
    headers: {
      Accept: "application/json",
    },
  });
  const raw = await response.json();
  return sanitizeStore(raw);
};

const persistStoreToBlob = async (store) => {
  await requestJsonBlob(blobUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(store),
  });
};

const getStore = async ({ forceRefresh = false } = {}) => {
  const shouldRefresh =
    forceRefresh || !storeCache || Date.now() - cacheUpdatedAt > READ_REFRESH_MS;

  if (shouldRefresh) {
    storeCache = await fetchStoreFromBlob();
    cacheUpdatedAt = Date.now();
  }
  return clone(storeCache);
};

const mutateStore = async (mutator) => {
  const resultPromise = mutationQueue.then(async () => {
    const currentStore = await getStore({ forceRefresh: true });
    const draft = clone(currentStore);
    const result = await mutator(draft);
    await persistStoreToBlob(draft);
    storeCache = draft;
    cacheUpdatedAt = Date.now();
    return result;
  });

  mutationQueue = resultPromise.catch(() => {});
  return resultPromise;
};

const nextId = (store, key) => {
  const id = store.nextIds[key];
  store.nextIds[key] = id + 1;
  return id;
};

const mapMovieWithStats = (movie, stats) => ({
  id: movie.id,
  title: movie.title,
  year: movie.year || null,
  imdbId: movie.imdbId || null,
  imdbRating: movie.imdbRating === null || movie.imdbRating === undefined ? null : Number(movie.imdbRating),
  runtimeMinutes:
    movie.runtimeMinutes === null || movie.runtimeMinutes === undefined
      ? null
      : Number(movie.runtimeMinutes),
  posterUrl: movie.posterUrl || null,
  genre: movie.genre || null,
  plot: movie.plot || null,
  category: stats?.category || null,
  addedBy: stats?.addedBy || [],
  addedCount: stats?.addedCount || 0,
});

const buildLibraryRows = (store, category = null) => {
  const usersById = new Map(store.users.map((user) => [user.id, user]));
  const moviesById = new Map(store.movies.map((movie) => [movie.id, movie]));
  const grouped = new Map();

  for (const entry of store.listEntries) {
    if (category && entry.category !== category) {
      continue;
    }
    const movie = moviesById.get(entry.movieId);
    const user = usersById.get(entry.userId);
    if (!movie || !user) {
      continue;
    }

    const key = `${entry.movieId}:${entry.category}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        movie,
        category: entry.category,
        addedBySet: new Set(),
        addedCount: 0,
      });
    }

    const group = grouped.get(key);
    group.addedBySet.add(user.name);
    group.addedCount += 1;
  }

  return Array.from(grouped.values())
    .map((group) =>
      mapMovieWithStats(group.movie, {
        category: group.category,
        addedBy: Array.from(group.addedBySet),
        addedCount: group.addedCount,
      }),
    )
    .sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category);
      }
      if (a.addedCount !== b.addedCount) {
        return b.addedCount - a.addedCount;
      }
      return a.title.localeCompare(b.title);
    });
};

const getSessionStateFromStore = (store, sessionId) => {
  const session = store.sessions.find((row) => row.id === sessionId);
  if (!session) {
    return null;
  }

  const users = [...store.users]
    .sort((a, b) => a.id - b.id)
    .map((user) => ({ id: user.id, name: user.name }));

  const queue = buildLibraryRows(store, session.category).map((movie) => ({
    ...movie,
    swipes: {},
    matched: false,
  }));
  const queueByMovieId = new Map(queue.map((movie) => [movie.id, movie]));

  for (const swipe of store.sessionSwipes) {
    if (swipe.sessionId !== sessionId) {
      continue;
    }
    const queueMovie = queueByMovieId.get(swipe.movieId);
    if (!queueMovie) {
      continue;
    }
    queueMovie.swipes[swipe.userId] = Boolean(swipe.liked);
  }

  const matches = [];
  const matchesForSession = store.matches
    .filter((match) => match.sessionId === sessionId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const moviesById = new Map(store.movies.map((movie) => [movie.id, movie]));

  for (const match of matchesForSession) {
    const matchedMovie = queueByMovieId.get(match.movieId);
    if (matchedMovie) {
      matchedMovie.matched = true;
    }
    const movie = moviesById.get(match.movieId);
    if (movie) {
      matches.push(mapMovieWithStats(movie));
    }
  }

  return {
    session: {
      id: session.id,
      category: session.category,
      createdAt: session.createdAt,
    },
    users,
    queue,
    matches,
  };
};

app.use(cors());
app.use(express.json());

app.get("/api/health", async (_req, res) => {
  try {
    await getStore();
    res.json({ ok: true });
  } catch (_error) {
    res.status(500).json({ ok: false });
  }
});

app.get("/api/users", async (_req, res) => {
  try {
    const store = await getStore();
    const users = [...store.users]
      .sort((a, b) => a.id - b.id)
      .map((user) => ({ id: user.id, name: user.name }));
    res.json(users);
  } catch (_error) {
    res.status(500).json({ error: "Unable to read users." });
  }
});

app.post("/api/users", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) {
    return res.status(400).json({ error: "Name is required." });
  }
  if (name.length > 40) {
    return res.status(400).json({ error: "Name must be 40 characters or fewer." });
  }

  try {
    const user = await mutateStore((store) => {
      const exists = store.users.some((row) => row.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        const error = new Error("That user already exists.");
        error.code = "CONFLICT";
        throw error;
      }
      const created = {
        id: nextId(store, "user"),
        name,
        createdAt: nowIso(),
      };
      store.users.push(created);
      return { id: created.id, name: created.name };
    });
    return res.status(201).json(user);
  } catch (error) {
    if (error.code === "CONFLICT") {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: "Unable to create user." });
  }
});

app.get("/api/library", async (req, res) => {
  const category = req.query.category ? normalizeCategory(req.query.category) : null;
  try {
    const store = await getStore();
    const rows = buildLibraryRows(store, category);
    res.json(rows);
  } catch (_error) {
    res.status(500).json({ error: "Unable to read library." });
  }
});

app.get("/api/movies/search", async (req, res) => {
  const query = String(req.query?.query || "").trim();
  if (query.length < 2) {
    return res.json([]);
  }
  if (!process.env.OMDB_API_KEY) {
    return res.status(400).json({
      error:
        "OMDB_API_KEY is not configured. Add it to server/.env to use title autocomplete.",
    });
  }

  try {
    const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(process.env.OMDB_API_KEY)}&s=${encodeURIComponent(query)}&type=movie&page=1`;
    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res
        .status(response.status === 401 ? 400 : 502)
        .json({ error: payload.Error || "Could not reach OMDb right now." });
    }
    if (payload.Response === "False" || !Array.isArray(payload.Search)) {
      return res.status(payload.Error === "Invalid API key!" ? 400 : 200).json(
        payload.Error === "Invalid API key!"
          ? { error: payload.Error }
          : [],
      );
    }
    return res.json(
      payload.Search.slice(0, 10).map((movie) => ({
        title: movie.Title || "",
        year: movie.Year && movie.Year !== "N/A" ? movie.Year : null,
        imdbId: movie.imdbID && movie.imdbID !== "N/A" ? movie.imdbID : null,
        posterUrl: movie.Poster && movie.Poster !== "N/A" ? movie.Poster : null,
      })),
    );
  } catch (_error) {
    return res.status(500).json({ error: "Search failed. Please try again." });
  }
});

app.post("/api/movies/lookup", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const imdbId = String(req.body?.imdbId || "").trim();
  if (!title && !imdbId) {
    return res.status(400).json({ error: "Title or IMDb id is required." });
  }

  if (!process.env.OMDB_API_KEY) {
    return res.status(400).json({
      error:
        "OMDB_API_KEY is not configured. Add it to server/.env to use metadata lookup.",
    });
  }

  try {
    const queryParam = imdbId
      ? `i=${encodeURIComponent(imdbId)}`
      : `t=${encodeURIComponent(title)}&type=movie`;
    const url = `https://www.omdbapi.com/?apikey=${encodeURIComponent(process.env.OMDB_API_KEY)}&${queryParam}`;
    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res
        .status(response.status === 401 ? 400 : 502)
        .json({ error: payload.Error || "Could not reach OMDb right now." });
    }
    if (payload.Response === "False") {
      return res
        .status(payload.Error === "Invalid API key!" ? 400 : 404)
        .json({ error: payload.Error || "Movie not found." });
    }

    return res.json({
      title: payload.Title || title || null,
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

app.post("/api/library", async (req, res) => {
  const userId = Number(req.body?.userId);
  const category = normalizeCategory(req.body?.category);
  const title = String(req.body?.title || "").trim();

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: "A valid user is required." });
  }
  if (!title) {
    return res.status(400).json({ error: "Movie title is required." });
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

  try {
    const result = await mutateStore((store) => {
      const user = store.users.find((row) => row.id === userId);
      if (!user) {
        const error = new Error("User not found.");
        error.code = "NOT_FOUND";
        throw error;
      }

      let movie = null;
      if (imdbId) {
        movie = store.movies.find((row) => row.imdbId === imdbId) || null;
      } else {
        movie =
          store.movies.find(
            (row) =>
              row.title.toLowerCase() === title.toLowerCase() &&
              (row.year || "") === (year || ""),
          ) || null;
      }

      if (movie) {
        movie.title = title;
        movie.year = year;
        movie.imdbId = imdbId || movie.imdbId || null;
        movie.imdbRating = Number.isFinite(imdbRating) ? imdbRating : null;
        movie.runtimeMinutes = runtimeMinutes;
        movie.posterUrl = posterUrl;
        movie.genre = genre;
        movie.plot = plot;
      } else {
        movie = {
          id: nextId(store, "movie"),
          title,
          year,
          imdbId: imdbId || null,
          imdbRating: Number.isFinite(imdbRating) ? imdbRating : null,
          runtimeMinutes,
          posterUrl,
          genre,
          plot,
          createdAt: nowIso(),
        };
        store.movies.push(movie);
      }

      const existingEntry = store.listEntries.find(
        (entry) => entry.userId === userId && entry.movieId === movie.id && entry.category === category,
      );
      if (!existingEntry) {
        store.listEntries.push({
          id: nextId(store, "listEntry"),
          userId,
          movieId: movie.id,
          category,
          createdAt: nowIso(),
        });
      }

      const libraryRows = buildLibraryRows(store, category);
      const libraryMovie = libraryRows.find((row) => row.id === movie.id) || null;
      return {
        movie: libraryMovie,
        alreadyInList: Boolean(existingEntry),
      };
    });
    return res.status(201).json(result);
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Could not add this movie to your list." });
  }
});

app.post("/api/sessions/start", async (req, res) => {
  const category = normalizeCategory(req.body?.category);
  try {
    const state = await mutateStore((store) => {
      const session = {
        id: nextId(store, "session"),
        category,
        createdAt: nowIso(),
      };
      store.sessions.push(session);
      return getSessionStateFromStore(store, session.id);
    });
    res.status(201).json(state);
  } catch (_error) {
    res.status(500).json({ error: "Unable to start session." });
  }
});

app.get("/api/sessions/:sessionId/state", async (req, res) => {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: "Invalid session id." });
  }

  try {
    const store = await getStore();
    const state = getSessionStateFromStore(store, sessionId);
    if (!state) {
      return res.status(404).json({ error: "Session not found." });
    }
    return res.json(state);
  } catch (_error) {
    return res.status(500).json({ error: "Unable to load session state." });
  }
});

app.post("/api/sessions/:sessionId/swipe", async (req, res) => {
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

  try {
    const payload = await mutateStore((store) => {
      const session = store.sessions.find((row) => row.id === sessionId);
      if (!session) {
        const error = new Error("Session not found.");
        error.code = "NOT_FOUND";
        throw error;
      }
      const user = store.users.find((row) => row.id === userId);
      if (!user) {
        const error = new Error("User not found.");
        error.code = "NOT_FOUND";
        throw error;
      }
      const movie = store.movies.find((row) => row.id === movieId);
      if (!movie) {
        const error = new Error("Movie not found.");
        error.code = "NOT_FOUND";
        throw error;
      }

      const existingSwipe = store.sessionSwipes.find(
        (swipe) => swipe.sessionId === sessionId && swipe.userId === userId && swipe.movieId === movieId,
      );
      if (existingSwipe) {
        existingSwipe.liked = liked;
        existingSwipe.createdAt = nowIso();
      } else {
        store.sessionSwipes.push({
          id: nextId(store, "sessionSwipe"),
          sessionId,
          userId,
          movieId,
          liked,
          createdAt: nowIso(),
        });
      }

      const totalUsers = store.users.length;
      const yesCount = store.sessionSwipes.filter(
        (swipe) => swipe.sessionId === sessionId && swipe.movieId === movieId && swipe.liked,
      ).length;

      let newlyMatched = false;
      if (totalUsers > 0 && yesCount === totalUsers) {
        const existingMatch = store.matches.find(
          (match) => match.sessionId === sessionId && match.movieId === movieId,
        );
        if (!existingMatch) {
          store.matches.push({
            id: nextId(store, "match"),
            sessionId,
            movieId,
            createdAt: nowIso(),
          });
          newlyMatched = true;
        }
      }

      return {
        matched: newlyMatched,
        state: getSessionStateFromStore(store, sessionId),
      };
    });
    return res.json(payload);
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      return res.status(404).json({ error: error.message });
    }
    return res.status(500).json({ error: "Unable to save swipe." });
  }
});

app.get("/api/sessions/:sessionId/matches", async (req, res) => {
  const sessionId = Number(req.params.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: "Invalid session id." });
  }

  try {
    const store = await getStore();
    const session = store.sessions.find((row) => row.id === sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }

    const moviesById = new Map(store.movies.map((movie) => [movie.id, movie]));
    const matches = store.matches
      .filter((row) => row.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => moviesById.get(row.movieId))
      .filter(Boolean)
      .map((movie) => mapMovieWithStats(movie));

    return res.json(matches);
  } catch (_error) {
    return res.status(500).json({ error: "Unable to load matches." });
  }
});

const start = async () => {
  try {
    const configuredUrl = resolveConfiguredBlobUrl();
    if (configuredUrl) {
      blobUrl = configuredUrl;
      storeCache = await fetchStoreFromBlob();
      cacheUpdatedAt = Date.now();
    } else {
      const initialStore = createInitialStore(seedUsers);
      blobUrl = await createBlob(initialStore);
      storeCache = initialStore;
      cacheUpdatedAt = Date.now();
      // eslint-disable-next-line no-console
      console.log(`Created JSONBlob store at: ${blobUrl}`);
      // eslint-disable-next-line no-console
      console.log("Set JSONBLOB_ID or JSONBLOB_URL in server/.env to reuse this data.");
    }

    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Movie Night Matcher API running on http://localhost:${PORT}`);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to initialize JSONBlob store:", error.message);
    process.exit(1);
  }
};

start();
