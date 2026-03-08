import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const SUGGESTION_LIMIT = 8;
const ADDER_OPTIONS = ["Oskar", "Jasmina"];
const ADDER_STORAGE_KEY = "movie-night.adder-name";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? "https://movie-api.kokarn.com/" : "")
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

const MoviePosterThumb = ({ posterUrl, title }) =>
  posterUrl ? (
    <img className="movie-thumb" src={posterUrl} alt={`${title} poster`} loading="lazy" />
  ) : (
    <div className="movie-thumb placeholder" aria-hidden="true">
      No poster
    </div>
  );

const findMyNextMovieIndex = (queue, userId, startIndex = 0) => {
  if (!queue.length || !userId) {
    return -1;
  }

  for (let index = startIndex; index < queue.length; index += 1) {
    const movie = queue[index];
    if (!movie.matched && movie.swipes?.[userId] === undefined) {
      return index;
    }
  }

  for (let index = 0; index < startIndex; index += 1) {
    const movie = queue[index];
    if (!movie.matched && movie.swipes?.[userId] === undefined) {
      return index;
    }
  }

  return -1;
};

const getLatestMatch = (state) => (state?.matches?.length ? state.matches[0] : null);

function App() {
  const [users, setUsers] = useState([]);
  const [library, setLibrary] = useState([]);
  const [activeTab, setActiveTab] = useState("library");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [adderName, setAdderName] = useState(() => {
    if (typeof window === "undefined") {
      return ADDER_OPTIONS[0];
    }
    const stored = window.localStorage.getItem(ADDER_STORAGE_KEY);
    return ADDER_OPTIONS.includes(stored) ? stored : ADDER_OPTIONS[0];
  });

  const [form, setForm] = useState({
    userId: "",
    category: "regular",
    ...EMPTY_FORM,
  });
  const [titleSuggestions, setTitleSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const autocompleteMenuRef = useRef(null);

  const [nightCategory, setNightCategory] = useState("regular");
  const [joinCodeInput, setJoinCodeInput] = useState("");
  const [sessionState, setSessionState] = useState(null);
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [joinLoading, setJoinLoading] = useState(false);
  const [swipeLoading, setSwipeLoading] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [matchPopupMovie, setMatchPopupMovie] = useState(null);
  const [streamIssueMessage, setStreamIssueMessage] = useState("");
  const eventSourceRef = useRef(null);
  const lastMatchIdRef = useRef(null);
  const lastSessionRevisionRef = useRef({
    sessionId: null,
    updatedAt: null,
  });

  const groupedLibrary = useMemo(
    () => ({
      regular: library.filter((movie) => movie.category === "regular"),
      easy: library.filter((movie) => movie.category === "easy"),
    }),
    [library],
  );
  const selectedCategory = useMemo(
    () => CATEGORIES.find((category) => category.value === form.category) || CATEGORIES[0],
    [form.category],
  );
  const preferredAdderUser = useMemo(() => {
    const byName = users.find((user) => user.name.toLowerCase() === adderName.toLowerCase());
    if (byName) {
      return byName;
    }
    return (
      users.find((user) =>
        ADDER_OPTIONS.some((option) => option.toLowerCase() === user.name.toLowerCase()),
      ) || null
    );
  }, [adderName, users]);

  const applySessionState = useCallback((state, { suppressMatchPopup = false } = {}) => {
    const incomingSessionId = state?.session?.id || null;
    const incomingUpdatedAt = state?.session?.updatedAt || null;
    const { sessionId: previousSessionId, updatedAt: previousUpdatedAt } = lastSessionRevisionRef.current;

    if (
      incomingSessionId &&
      previousSessionId === incomingSessionId &&
      incomingUpdatedAt &&
      previousUpdatedAt &&
      incomingUpdatedAt < previousUpdatedAt
    ) {
      return;
    }

    if (incomingSessionId && previousSessionId !== incomingSessionId) {
      lastMatchIdRef.current = null;
    }

    lastSessionRevisionRef.current = {
      sessionId: incomingSessionId,
      updatedAt: incomingUpdatedAt || previousUpdatedAt || null,
    };

    setSessionState(state);
    const latestMatch = getLatestMatch(state);
    if (!latestMatch) {
      lastMatchIdRef.current = null;
      return;
    }
    if (suppressMatchPopup) {
      lastMatchIdRef.current = latestMatch.id;
      return;
    }
    if (lastMatchIdRef.current !== latestMatch.id) {
      lastMatchIdRef.current = latestMatch.id;
      setMatchPopupMovie(latestMatch);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    let payload = await requestJson("/api/users");
    const existingNames = new Set(payload.map((user) => user.name.toLowerCase()));
    const missingAdders = ADDER_OPTIONS.filter((name) => !existingNames.has(name.toLowerCase()));

    if (missingAdders.length) {
      await Promise.all(
        missingAdders.map((name) =>
          requestJson("/api/users", {
            method: "POST",
            body: JSON.stringify({ name }),
          }).catch(() => null),
        ),
      );
      payload = await requestJson("/api/users");
    }

    setUsers(payload);
    setSelectedUserId((current) => (current || !payload.length ? current : payload[0].id));
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get("join");
    if (joinCode) {
      setActiveTab("night");
      setJoinCodeInput(joinCode.toUpperCase());
    }
  }, []);

  useEffect(() => {
    if (!sessionState?.users?.length) {
      return;
    }
    const userIsInSession = sessionState.users.some((user) => user.id === selectedUserId);
    if (!userIsInSession) {
      setSelectedUserId(sessionState.users[0].id);
    }
  }, [selectedUserId, sessionState?.users]);

  const onTitleInputChange = (event) => {
    const value = event.target.value;
    setForm((current) => ({
      ...current,
      title: value,
      year: "",
      imdbId: "",
      imdbRating: "",
      runtimeMinutes: "",
      posterUrl: "",
      genre: "",
      plot: "",
    }));
    setSuggestionsOpen(Boolean(value.trim()));
  };

  const resetMessages = () => {
    setErrorMessage("");
    setStatusMessage("");
  };

  const applyLookupPayload = useCallback((payload) => {
    setForm((current) => ({
      ...current,
      title: payload.title || current.title,
      year: payload.year || "",
      imdbId: payload.imdbId || "",
      imdbRating:
        payload.imdbRating || payload.imdbRating === 0 ? String(payload.imdbRating) : "",
      runtimeMinutes:
        payload.runtimeMinutes || payload.runtimeMinutes === 0 ? String(payload.runtimeMinutes) : "",
      posterUrl: payload.posterUrl || "",
      genre: payload.genre || "",
      plot: payload.plot || "",
    }));
  }, []);

  const selectSuggestion = async (suggestion) => {
    setSuggestionsOpen(false);
    setTitleSuggestions([]);
    setErrorMessage("");
    setSelectionLoading(true);
    try {
      const payload = await requestJson("/api/movies/lookup", {
        method: "POST",
        body: JSON.stringify({
          title: suggestion.title,
          imdbId: suggestion.imdbId,
        }),
      });
      applyLookupPayload(payload);
    } catch (error) {
      setErrorMessage(error.message);
      setForm((current) => ({ ...current, title: suggestion.title }));
    } finally {
      setSelectionLoading(false);
    }
  };

  useEffect(() => {
    const query = form.title.trim();
    if (query.length < 2) {
      setTitleSuggestions([]);
      setSuggestionsLoading(false);
      return;
    }

    let cancelled = false;
    const timeoutId = setTimeout(async () => {
      setSuggestionsLoading(true);
      try {
        const payload = await requestJson(`/api/movies/search?query=${encodeURIComponent(query)}`);
        if (cancelled) {
          return;
        }
        setErrorMessage("");
        setTitleSuggestions(Array.isArray(payload) ? payload.slice(0, SUGGESTION_LIMIT) : []);
      } catch (error) {
        if (!cancelled) {
          setTitleSuggestions([]);
          setErrorMessage(error.message || "Could not load title suggestions.");
        }
      } finally {
        if (!cancelled) {
          setSuggestionsLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [form.title]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ADDER_STORAGE_KEY, adderName);
    }
  }, [adderName]);

  useEffect(() => {
    if (!suggestionsOpen || !titleSuggestions.length) {
      return;
    }

    const menu = autocompleteMenuRef.current;
    if (menu) {
      menu.scrollTop = menu.scrollHeight;
    }
  }, [suggestionsOpen, titleSuggestions]);

  useEffect(() => {
    if (!preferredAdderUser) {
      return;
    }
    setForm((current) => ({
      ...current,
      userId: String(preferredAdderUser.id),
    }));
  }, [preferredAdderUser]);

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
      const lookupPayload = await requestJson("/api/movies/lookup", {
        method: "POST",
        body: JSON.stringify({
          title: form.title.trim(),
          imdbId: form.imdbId || undefined,
        }),
      });
      applyLookupPayload(lookupPayload);

      const payload = await requestJson("/api/library", {
        method: "POST",
        body: JSON.stringify({
          userId: Number(form.userId),
          category: form.category,
          title: lookupPayload.title || form.title.trim(),
          year: lookupPayload.year || null,
          imdbId: lookupPayload.imdbId || null,
          imdbRating:
            lookupPayload.imdbRating || lookupPayload.imdbRating === 0 ? lookupPayload.imdbRating : null,
          runtimeMinutes:
            lookupPayload.runtimeMinutes || lookupPayload.runtimeMinutes === 0
              ? lookupPayload.runtimeMinutes
              : null,
          posterUrl: lookupPayload.posterUrl || null,
          genre: lookupPayload.genre || null,
          plot: lookupPayload.plot || null,
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
      applySessionState(state, { suppressMatchPopup: true });
      setJoinCodeInput(state.session.joinCode || "");
      setActiveTab("night");
      setStatusMessage("Movie night started.");
    } catch (error) {
      setErrorMessage(error.message);
    }
  };

  const joinSessionByCode = async (event) => {
    event.preventDefault();
    resetMessages();
    const joinCode = joinCodeInput.trim().toUpperCase();
    if (!joinCode) {
      setErrorMessage("Enter a join code first.");
      return;
    }

    setJoinLoading(true);
    try {
      const state = await requestJson(`/api/sessions/by-code/${encodeURIComponent(joinCode)}/state`);
      applySessionState(state, { suppressMatchPopup: true });
      setJoinCodeInput(state.session.joinCode || joinCode);
      setActiveTab("night");
      setStatusMessage(`Joined session ${state.session.joinCode}.`);
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setJoinLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionState?.session?.id) {
      setStreamConnected(false);
      setStreamIssueMessage("");
      return undefined;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/api/sessions/${sessionState.session.id}/events`,
    );
    eventSourceRef.current = eventSource;
    setStreamIssueMessage("");

    eventSource.addEventListener("open", () => {
      setStreamConnected(true);
      setStreamIssueMessage("");
    });

    eventSource.addEventListener("state", (event) => {
      const payload = JSON.parse(event.data);
      applySessionState(payload);
      setStreamConnected(true);
      setStreamIssueMessage("");
    });

    eventSource.addEventListener("match", (event) => {
      const payload = JSON.parse(event.data);
      if (payload?.movie?.id) {
        setMatchPopupMovie(payload.movie);
      }
    });

    eventSource.onerror = () => {
      setStreamConnected(false);
      setStreamIssueMessage("Live updates disconnected. Reconnecting...");
    };

    return () => {
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
    };
  }, [applySessionState, sessionState?.session?.id]);

  const submitSwipe = async (liked) => {
    if (!sessionState || !selectedUserId) {
      return;
    }

    const movieIndex = findMyNextMovieIndex(sessionState.queue, selectedUserId, 0);
    const movie = sessionState.queue[movieIndex];
    if (!movie) {
      return;
    }

    setSwipeLoading(true);
    resetMessages();
    try {
      const payload = await requestJson(`/api/sessions/${sessionState.session.id}/swipe`, {
        method: "POST",
        body: JSON.stringify({
          userId: selectedUserId,
          movieId: movie.id,
          liked,
        }),
      });

      applySessionState(payload.state);
      if (payload.matched) {
        setStatusMessage(`It's a match! Everyone liked "${movie.title}".`);
      }
    } catch (error) {
      setErrorMessage(error.message);
    } finally {
      setSwipeLoading(false);
    }
  };
  const selectedUser = users.find((user) => user.id === selectedUserId);
  const currentMovieIndex = useMemo(
    () => findMyNextMovieIndex(sessionState?.queue || [], selectedUserId, 0),
    [sessionState?.queue, selectedUserId],
  );
  const currentMovie =
    sessionState && currentMovieIndex >= 0 ? sessionState.queue[currentMovieIndex] : null;
  const swipeProgress = useMemo(() => {
    const queue = sessionState?.queue || [];
    const sessionUsers = sessionState?.users || [];
    if (!queue.length || !selectedUserId) {
      return { myPendingSwipeCount: 0, othersPendingSwipeCount: 0 };
    }

    let myPendingSwipeCount = 0;
    let othersPendingSwipeCount = 0;

    for (const movie of queue) {
      if (movie.matched) {
        continue;
      }

      const mySwipe = movie.swipes?.[selectedUserId];
      if (mySwipe === undefined) {
        myPendingSwipeCount += 1;
        continue;
      }

      const othersMissingSwipe = sessionUsers.some(
        (user) => user.id !== selectedUserId && movie.swipes?.[user.id] === undefined,
      );
      if (othersMissingSwipe) {
        othersPendingSwipeCount += 1;
      }
    }

    return { myPendingSwipeCount, othersPendingSwipeCount };
  }, [sessionState?.queue, sessionState?.users, selectedUserId]);
  const isDeckCompleteForMe = Boolean(
    sessionState && !currentMovie && selectedUserId && swipeProgress.myPendingSwipeCount === 0,
  );
  const isWaitingForOthers = isDeckCompleteForMe && swipeProgress.othersPendingSwipeCount > 0;
  const isNoMatchOutcome =
    isDeckCompleteForMe &&
    swipeProgress.othersPendingSwipeCount === 0 &&
    (sessionState?.matches?.length || 0) === 0;
  const isDeckFinishedWithMatches =
    isDeckCompleteForMe &&
    swipeProgress.othersPendingSwipeCount === 0 &&
    (sessionState?.matches?.length || 0) > 0;

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
      {sessionState ? (
        <p className={`banner ${streamConnected ? "success" : "error"}`}>
          {streamConnected ? "Live updates connected." : streamIssueMessage || "Connecting to live updates..."}
        </p>
      ) : null}

      {matchPopupMovie ? (
        <div className="match-popup-backdrop" role="dialog" aria-modal="true" aria-label="Match found">
          <div className="match-popup">
            <h3>Match found!</h3>
            <p>
              Everyone swiped right on <strong>{matchPopupMovie.title}</strong>
              {matchPopupMovie.year ? ` (${matchPopupMovie.year})` : ""}.
            </p>
            <button type="button" onClick={() => setMatchPopupMovie(null)}>
              Nice
            </button>
          </div>
        </div>
      ) : null}

      {activeTab === "library" ? (
        <section className="layout-two-columns">
          <article className={suggestionsOpen ? "panel panel-autocomplete-active" : "panel"}>
            <h2>Add movie</h2>
            <form onSubmit={addMovie} className="stack-form">
              <div className="list-type-section">
                <p className="list-type-label">Add to list type</p>
                <div className="list-type-tabs" role="tablist" aria-label="Choose list type">
                  {CATEGORIES.map((category) => (
                    <button
                      key={category.value}
                      type="button"
                      role="tab"
                      aria-selected={form.category === category.value}
                      className={form.category === category.value ? "list-type-tab active" : "list-type-tab"}
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          category: category.value,
                        }))
                      }
                    >
                      {category.label}
                    </button>
                  ))}
                </div>
                <p className="muted form-help">Movies added now go to: {selectedCategory.label}</p>
              </div>

              <div className="list-type-section">
                <p className="list-type-label">Adding as</p>
                <div className="list-type-tabs" role="tablist" aria-label="Choose who is adding">
                  {ADDER_OPTIONS.map((name) => (
                    <button
                      key={name}
                      type="button"
                      role="tab"
                      aria-selected={adderName === name}
                      className={adderName === name ? "list-type-tab active" : "list-type-tab"}
                      onClick={() => setAdderName(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>

              <label>
                Movie title
                <div className="autocomplete-wrap">
                  <input
                    value={form.title}
                    onChange={onTitleInputChange}
                    onFocus={() => setSuggestionsOpen(true)}
                    onBlur={() => setTimeout(() => setSuggestionsOpen(false), 100)}
                    placeholder="Type at least 2 characters..."
                    autoComplete="off"
                  />
                  {suggestionsOpen ? (
                    <div ref={autocompleteMenuRef} className="autocomplete-menu">
                      {suggestionsLoading ? (
                        <p className="autocomplete-empty">Searching titles...</p>
                      ) : titleSuggestions.length ? (
                        <ul className="autocomplete-list">
                          {[...titleSuggestions].reverse().map((movie) => (
                            <li key={movie.imdbId || `${movie.title}-${movie.year || "unknown"}`}>
                              <button
                                type="button"
                                className="autocomplete-item"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => selectSuggestion(movie)}
                              >
                                {movie.posterUrl ? (
                                  <img
                                    className="autocomplete-poster"
                                    src={movie.posterUrl}
                                    alt={`${movie.title} poster`}
                                    loading="lazy"
                                  />
                                ) : (
                                  <div className="autocomplete-poster placeholder" aria-hidden="true">
                                    No poster
                                  </div>
                                )}
                                <div className="autocomplete-copy">
                                  <span>{movie.title}</span>
                                  <small>{movie.year || "Unknown year"}</small>
                                </div>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="autocomplete-empty">No suggestions yet.</p>
                      )}
                    </div>
                  ) : null}
                </div>
              </label>

              <p className="muted form-help">
                Select a suggestion to auto-fill IMDb data, then we save with one click.
              </p>
              {form.posterUrl ? (
                <div className="selected-poster-preview">
                  <img
                    className="movie-thumb"
                    src={form.posterUrl}
                    alt={`${form.title || "Selected movie"} poster preview`}
                    loading="lazy"
                  />
                  <small className="muted">Poster preview for the selected title</small>
                </div>
              ) : null}

              <button type="submit" disabled={saveLoading || selectionLoading}>
                {saveLoading || selectionLoading ? "Saving..." : "Add movie to list"}
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
                        <MoviePosterThumb posterUrl={movie.posterUrl} title={movie.title} />
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

            <form onSubmit={joinSessionByCode} className="inline-form join-session-form">
              <input
                value={joinCodeInput}
                onChange={(event) => setJoinCodeInput(event.target.value.toUpperCase())}
                placeholder="Join code"
                maxLength={8}
              />
              <button type="submit" disabled={joinLoading}>
                {joinLoading ? "Joining..." : "Join session"}
              </button>
            </form>

            <label>
              You are swiping as
              <select
                value={selectedUserId || ""}
                onChange={(event) => setSelectedUserId(Number(event.target.value))}
                disabled={!users.length}
              >
                {!users.length ? <option value="">No users yet</option> : null}
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>

            {sessionState ? (
              <div className="session-meta">
                <p>
                  Session #{sessionState.session.id} ({sessionState.session.category})
                </p>
                <p>Join code: {sessionState.session.joinCode || "Unavailable"}</p>
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
              isWaitingForOthers ? (
                <div className="swipe-terminal-state waiting" role="status" aria-live="polite">
                  <span className="waiting-spinner" aria-hidden="true" />
                  <p className="muted">
                    You&apos;ve swiped all movies. Waiting for the other person to finish...
                  </p>
                </div>
              ) : isNoMatchOutcome ? (
                <p className="muted swipe-terminal-state">
                  No shared picks this round. Start a new swipe session or add more movies.
                </p>
              ) : isDeckFinishedWithMatches ? (
                <p className="muted swipe-terminal-state">
                  Swiping is complete. Check your matches below.
                </p>
              ) : (
                <p className="muted swipe-terminal-state">All movies are swiped. Check your matches below.</p>
              )
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
                    Swiping as: <strong>{selectedUser?.name || "Unknown"}</strong>
                  </p>
                </div>
                <div className="swipe-actions">
                  <button
                    type="button"
                    className="reject"
                    onClick={() => submitSwipe(false)}
                    disabled={swipeLoading || !selectedUserId}
                  >
                    Swipe left
                  </button>
                  <button
                    type="button"
                    className="accept"
                    onClick={() => submitSwipe(true)}
                    disabled={swipeLoading || !selectedUserId}
                  >
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
                      <MoviePosterThumb posterUrl={movie.posterUrl} title={movie.title} />
                      <div>
                        <strong>
                          {movie.title}
                          {movie.year ? ` (${movie.year})` : ""}
                        </strong>
                        <span>IMDb: {formatRating(movie.imdbRating)}</span>
                      </div>
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
