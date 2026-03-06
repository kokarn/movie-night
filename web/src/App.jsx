import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";

const CATEGORIES = [
  { value: "regular", label: "Movies" },
  { value: "easy", label: "Easy watching" },
];

const EMPTY_FORM = {
  title: "",
  year: "",
  imdbId: "",
  imdbRating: "",
  runtimeMinutes: "",
  posterUrl: "",
  genre: "",
  plot: "",
};

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? "http://movie-api.kokarn.com/" : "")
).replace(/\/$/, "");

const requestJson = async (url, options = {}) => {
  const resolvedUrl =
    API_BASE_URL && url.startsWith("/") ? `${API_BASE_URL}${url}` : url;

  const response = await fetch(resolvedUrl, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
};

const formatRuntime = (runtimeMinutes) =>
  runtimeMinutes ? `${runtimeMinutes} min` : "Runtime unknown";

const formatRating = (imdbRating) =>
  imdbRating || imdbRating === 0 ? imdbRating.toFixed(1) : "N/A";

const findNextPendingMovieIndex = (queue, users, startIndex = 0) => {
  if (!queue.length || !users.length) {
    return -1;
  }

  for (let index = startIndex; index < queue.length; index += 1) {
    const movie = queue[index];
    const swipeCount = Object.keys(movie.swipes || {}).length;
    if (!movie.matched && swipeCount < users.length) {
      return index;
    }
  }

  for (let index = 0; index < startIndex; index += 1) {
    const movie = queue[index];
    const swipeCount = Object.keys(movie.swipes || {}).length;
    if (!movie.matched && swipeCount < users.length) {
      return index;
    }
  }

  return -1;
};

const pickNextSwiper = (movie, users) => {
  if (!movie) {
    return null;
  }
  for (const user of users) {
    if (movie.swipes?.[user.id] === undefined) {
      return user.id;
    }
  }
  return users[0]?.id ?? null;
};

function App() {
  const [users, setUsers] = useState([]);
  const [newUserName, setNewUserName] = useState("");
  const [library, setLibrary] = useState([]);
  const [activeTab, setActiveTab] = useState("library");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const [form, setForm] = useState({
    userId: "",
    category: "regular",
    ...EMPTY_FORM,
  });
  const [lookupLoading, setLookupLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);

  const [nightCategory, setNightCategory] = useState("regular");
  const [sessionState, setSessionState] = useState(null);
  const [currentMovieIndex, setCurrentMovieIndex] = useState(-1);
  const [activeSwiperUserId, setActiveSwiperUserId] = useState(null);
  const [swipeLoading, setSwipeLoading] = useState(false);

  const groupedLibrary = useMemo(
    () => ({
      regular: library.filter((movie) => movie.category === "regular"),
      easy: library.filter((movie) => movie.category === "easy"),
    }),
    [library],
  );

  const syncSessionProgress = (state, preferredStartIndex = 0) => {
    if (!state) {
      setCurrentMovieIndex(-1);
      setActiveSwiperUserId(null);
      return;
    }

    const nextIndex = findNextPendingMovieIndex(state.queue, state.users, preferredStartIndex);
    setCurrentMovieIndex(nextIndex);

    if (nextIndex === -1) {
      setActiveSwiperUserId(state.users[0]?.id ?? null);
      return;
    }

    const nextUserId = pickNextSwiper(state.queue[nextIndex], state.users);
    setActiveSwiperUserId(nextUserId);
  };

  const loadUsers = useCallback(async () => {
    const payload = await requestJson("/api/users");
    setUsers(payload);

    setForm((current) =>
      current.userId || !payload.length
        ? current
        : { ...current, userId: String(payload[0].id) },
    );
    setActiveSwiperUserId((current) =>
      current || !payload.length ? current : payload[0].id,
    );
  }, []);

  const loadLibrary = useCallback(async () => {
    const payload = await requestJson("/api/library");
    setLibrary(payload);
  }, []);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        await Promise.all([loadUsers(), loadLibrary()]);
      } catch (error) {
        setErrorMessage(error.message);
      }
    };
    bootstrap();
  }, [loadLibrary, loadUsers]);

  const onInputChange = (field) => (event) => {
    const value = event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
  };

  const resetMessages = () => {
    setErrorMessage("");
    setStatusMessage("");
  };

  const addUser = async (event) => {
    event.preventDefault();
    resetMessages();

    if (!newUserName.trim()) {
      setErrorMessage("Enter a name first.");
      return;
    }

    try {
      await requestJson("/api/users", {
        method: "POST",
        body: JSON.stringify({ name: newUserName.trim() }),
      });
      setNewUserName("");
      await loadUsers();
      setStatusMessage("User added.");
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const lookupMovie = async () => {
    resetMessages();

    if (!form.title.trim()) {
      setErrorMessage("Type a movie title to look up.");
      return;
    }

    setLookupLoading(true);
    try {
      const payload = await requestJson("/api/movies/lookup", {
        method: "POST",
        body: JSON.stringify({ title: form.title }),
      });

      setForm((current) => ({
        ...current,
        title: payload.title || current.title,
        year: payload.year || "",
        imdbId: payload.imdbId || "",
        imdbRating:
          payload.imdbRating || payload.imdbRating === 0 ? String(payload.imdbRating) : "",
        runtimeMinutes:
          payload.runtimeMinutes || payload.runtimeMinutes === 0
            ? String(payload.runtimeMinutes)
            : "",
        posterUrl: payload.posterUrl || "",
        genre: payload.genre || "",
        plot: payload.plot || "",
      }));
      setStatusMessage("Metadata loaded from OMDb.");
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const addMovie = async (event) => {
    event.preventDefault();
    resetMessages();

    if (!form.userId) {
      setErrorMessage("Pick who is adding this movie.");
      return;
    }
    if (!form.title.trim()) {
      setErrorMessage("Movie title is required.");
      return;
    }

    setSaveLoading(true);
    try {
      const payload = await requestJson("/api/library", {
        method: "POST",
        body: JSON.stringify({
          userId: Number(form.userId),
          category: form.category,
          title: form.title.trim(),
          year: form.year || null,
          imdbId: form.imdbId || null,
          imdbRating: form.imdbRating || null,
          runtimeMinutes: form.runtimeMinutes || null,
          posterUrl: form.posterUrl || null,
          genre: form.genre || null,
          plot: form.plot || null,
        }),
      });

      await loadLibrary();
      setForm((current) => ({
        ...current,
        ...EMPTY_FORM,
      }));
      setStatusMessage(
        payload.alreadyInList
          ? "Movie already existed in that list."
          : "Movie added to your list.",
      );
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSaveLoading(false);
    }
  };

  const startSession = async () => {
    resetMessages();
    try {
      const state = await requestJson("/api/sessions/start", {
        method: "POST",
        body: JSON.stringify({ category: nightCategory }),
      });
      setSessionState(state);
      syncSessionProgress(state, 0);
      setActiveTab("night");
      setStatusMessage("Movie night started.");
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const submitSwipe = async (liked) => {
    if (!sessionState || currentMovieIndex === -1 || !activeSwiperUserId) {
      return;
    }

    const movie = sessionState.queue[currentMovieIndex];
    if (!movie) {
      return;
    }

    setSwipeLoading(true);
    resetMessages();
    try {
      const payload = await requestJson(`/api/sessions/${sessionState.session.id}/swipe`, {
        method: "POST",
        body: JSON.stringify({
          userId: activeSwiperUserId,
          movieId: movie.id,
          liked,
        }),
      });

      setSessionState(payload.state);
      syncSessionProgress(payload.state, currentMovieIndex);
      if (payload.matched) {
        setStatusMessage(`It's a match! You both picked "${movie.title}".`);
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSwipeLoading(false);
    }
  };

  const currentMovie =
    sessionState && currentMovieIndex >= 0 ? sessionState.queue[currentMovieIndex] : null;
  const activeSwiper = users.find((user) => user.id === activeSwiperUserId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Movie Night Matcher</h1>
          <p>Build shared watchlists and swipe to your perfect movie-night match.</p>
        </div>
        <nav className="tabs">
          <button
            type="button"
            className={activeTab === "library" ? "tab active" : "tab"}
            onClick={() => setActiveTab("library")}
          >
            Shared lists
          </button>
          <button
            type="button"
            className={activeTab === "night" ? "tab active" : "tab"}
            onClick={() => setActiveTab("night")}
          >
            Movie night
          </button>
        </nav>
      </header>

      {statusMessage ? <p className="banner success">{statusMessage}</p> : null}
      {errorMessage ? <p className="banner error">{errorMessage}</p> : null}

      {activeTab === "library" ? (
        <section className="layout-two-columns">
          <article className="panel">
            <h2>Add movie</h2>
            <form onSubmit={addUser} className="inline-form">
              <input
                value={newUserName}
                onChange={(event) => setNewUserName(event.target.value)}
                placeholder="Add person (optional)"
              />
              <button type="submit">Add person</button>
            </form>

            <form onSubmit={addMovie} className="stack-form">
              <label>
                Added by
                <select value={form.userId} onChange={onInputChange("userId")}>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Category
                <select value={form.category} onChange={onInputChange("category")}>
                  {CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Movie title
                <input
                  value={form.title}
                  onChange={onInputChange("title")}
                  placeholder="e.g. About Time"
                />
              </label>

              <button type="button" onClick={lookupMovie} disabled={lookupLoading}>
                {lookupLoading ? "Looking up..." : "Lookup metadata from OMDb"}
              </button>

              <div className="grid-two">
                <label>
                  Year
                  <input value={form.year} onChange={onInputChange("year")} />
                </label>
                <label>
                  IMDb ID
                  <input value={form.imdbId} onChange={onInputChange("imdbId")} />
                </label>
                <label>
                  IMDb score
                  <input value={form.imdbRating} onChange={onInputChange("imdbRating")} />
                </label>
                <label>
                  Runtime (minutes)
                  <input value={form.runtimeMinutes} onChange={onInputChange("runtimeMinutes")} />
                </label>
              </div>

              <label>
                Poster URL
                <input value={form.posterUrl} onChange={onInputChange("posterUrl")} />
              </label>
              <label>
                Genre
                <input value={form.genre} onChange={onInputChange("genre")} />
              </label>
              <label>
                Plot
                <textarea value={form.plot} onChange={onInputChange("plot")} rows={3} />
              </label>

              <button type="submit" disabled={saveLoading}>
                {saveLoading ? "Saving..." : "Add movie to list"}
              </button>
            </form>
          </article>

          <article className="panel">
            <h2>Shared lists</h2>
            {CATEGORIES.map((category) => (
              <section key={category.value} className="category-block">
                <h3>{category.label}</h3>
                {groupedLibrary[category.value].length === 0 ? (
                  <p className="muted">No movies yet.</p>
                ) : (
                  <ul className="movie-list">
                    {groupedLibrary[category.value].map((movie) => (
                      <li key={`${category.value}-${movie.id}`} className="movie-row">
                        <div>
                          <strong>
                            {movie.title}
                            {movie.year ? ` (${movie.year})` : ""}
                          </strong>
                          <div className="movie-meta">
                            <span>IMDb: {formatRating(movie.imdbRating)}</span>
                            <span>{formatRuntime(movie.runtimeMinutes)}</span>
                            {movie.genre ? <span>{movie.genre}</span> : null}
                          </div>
                          <small>Added by: {movie.addedBy.join(", ")}</small>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </article>
        </section>
      ) : (
        <section className="layout-two-columns">
          <article className="panel">
            <h2>Start movie night</h2>
            <label>
              Swipe category
              <select value={nightCategory} onChange={(event) => setNightCategory(event.target.value)}>
                {CATEGORIES.map((category) => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={startSession}>
              Start new swipe session
            </button>

            {sessionState ? (
              <div className="session-meta">
                <p>
                  Session #{sessionState.session.id} ({sessionState.session.category})
                </p>
                <p>
                  Queue size: {sessionState.queue.length} movies | Matches: {sessionState.matches.length}
                </p>
              </div>
            ) : null}
          </article>

          <article className="panel">
            <h2>Swipe deck</h2>
            {!sessionState ? (
              <p className="muted">Start a session to begin swiping.</p>
            ) : sessionState.queue.length === 0 ? (
              <p className="muted">
                No movies in this category yet. Add some in the shared list tab first.
              </p>
            ) : !currentMovie ? (
              <p className="muted">All movies are swiped. Check your matches below.</p>
            ) : (
              <div className="swipe-card">
                <div className="swipe-media">
                  {currentMovie.posterUrl ? (
                    <img src={currentMovie.posterUrl} alt={currentMovie.title} />
                  ) : (
                    <div className="poster-placeholder">No poster</div>
                  )}
                </div>
                <div className="swipe-content">
                  <h3>
                    {currentMovie.title}
                    {currentMovie.year ? ` (${currentMovie.year})` : ""}
                  </h3>
                  <p className="movie-meta">
                    <span>IMDb: {formatRating(currentMovie.imdbRating)}</span>
                    <span>{formatRuntime(currentMovie.runtimeMinutes)}</span>
                  </p>
                  {currentMovie.plot ? <p>{currentMovie.plot}</p> : null}
                  <small>Added by: {currentMovie.addedBy.join(", ")}</small>
                  <p className="turn-text">
                    Turn: <strong>{activeSwiper?.name || "Unknown"}</strong>
                  </p>
                </div>
                <div className="swipe-actions">
                  <button type="button" className="reject" onClick={() => submitSwipe(false)} disabled={swipeLoading}>
                    Swipe left
                  </button>
                  <button type="button" className="accept" onClick={() => submitSwipe(true)} disabled={swipeLoading}>
                    Swipe right
                  </button>
                </div>
              </div>
            )}

            <section className="matches">
              <h3>Matches</h3>
              {sessionState?.matches.length ? (
                <ul className="movie-list">
                  {sessionState.matches.map((movie) => (
                    <li key={`match-${movie.id}`} className="movie-row">
                      <strong>
                        {movie.title}
                        {movie.year ? ` (${movie.year})` : ""}
                      </strong>
                      <span>IMDb: {formatRating(movie.imdbRating)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No matches yet.</p>
              )}
            </section>
          </article>
        </section>
      )}
    </main>
  );
}

export default App;
