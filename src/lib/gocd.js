/**
 * A GoCD REST client for the extension service worker.
 *
 * This is the whole point of GoCD Lens: the JSON API stays up and correct even
 * when the GoCD web dashboard is restarting, re-rendering, or has decided your
 * pipelines do not exist. Nothing here touches the web UI's HTML -- every
 * screen is built from these endpoints.
 *
 * Endpoint choices and Accept versions match lazygocd, which is verified
 * against GoCD 23.5.0.
 */

/** Names come back from the server and are interpolated into request paths. */
export function encodeSegment(s) {
  let out = "";
  for (const byte of new TextEncoder().encode(String(s))) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export class GoCdError extends Error {
  constructor(message, { status = 0, kind = "http" } = {}) {
    super(message);
    this.name = "GoCdError";
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Error bodies are normally GoCD JSON, but a proxy or load balancer in front of
 * it answers with an HTML page. Echoing that markup into the UI is noise.
 */
function summarise(body) {
  const text = String(body || "").trim();
  if (!text) return "";
  if (text.startsWith("<") || /<html/i.test(text)) {
    return "a proxy or gateway answered instead of GoCD";
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON, fall through to the raw text */
  }
  return [...text].slice(0, 300).join("");
}

const TIMEOUT_MS = 45_000;

export class GoCdClient {
  /** @param {import('./store.js').Connection} conn */
  constructor(conn) {
    if (!conn || !conn.serverUrl)
      throw new GoCdError("No GoCD server configured", { kind: "config" });
    this.base = String(conn.serverUrl).replace(/\/+$/, "");
    this.auth = conn;
  }

  get origin() {
    return new URL(this.base).origin + "/*";
  }

  /**
   * Session mode rides the cookie you already have from logging into GoCD in
   * this browser, so there is no secret to store at all. Token and basic modes
   * send an explicit header and deliberately suppress cookies, so a stale
   * session can never silently stand in for the credential you configured.
   */
  #authHeaders() {
    const h = {};
    if (this.auth.authMode === "token" && this.auth.token) {
      h.Authorization = `Bearer ${this.auth.token}`;
    } else if (this.auth.authMode === "basic" && this.auth.username) {
      const raw = `${this.auth.username}:${this.auth.password || ""}`;
      h.Authorization = `Basic ${btoa(unescape(encodeURIComponent(raw)))}`;
    }
    return h;
  }

  #credentials() {
    return this.auth.authMode === "session" ? "include" : "omit";
  }

  async #send(
    method,
    path,
    { version, body, headers = {}, raw = false, signal } = {},
  ) {
    const url = `${this.base}${path}`;
    const requestHeaders = { ...this.#authHeaders(), ...headers };
    if (version)
      requestHeaders.Accept = `application/vnd.go.cd.v${version}+json`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    if (signal)
      signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: requestHeaders,
        body,
        credentials: this.#credentials(),
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new GoCdError("GoCD did not answer in time", { kind: "timeout" });
      }
      throw new GoCdError(
        `Cannot reach ${this.base} -- check the URL, your VPN, and that this extension has permission for that host.`,
        { kind: "network" },
      );
    }
    clearTimeout(timer);

    if (response.status === 304)
      return { notModified: true, etag: response.headers.get("ETag") };

    // GoCD answers an unauthenticated browser request with a redirect to the
    // login page, which `redirect: follow` turns into an HTML 200. Treat that
    // as the 401 it really is instead of trying to parse a login form as JSON.
    if (
      raw === false &&
      response.redirected &&
      /\/auth\/login/.test(response.url)
    ) {
      throw new GoCdError(
        "GoCD redirected to its login page -- your session has expired.",
        {
          status: 401,
          kind: "auth",
        },
      );
    }

    const text = await response.text();

    if (!response.ok) {
      const detail = summarise(text);
      if (response.status === 401) {
        throw new GoCdError(
          `GoCD rejected the credential (401). ${detail}`.trim(),
          {
            status: 401,
            kind: "auth",
          },
        );
      }
      if (response.status === 403) {
        throw new GoCdError(
          `GoCD refused this action (403). ${detail || "Your account may not have permission, or the server wants a CSRF token -- a personal access token avoids that."}`,
          { status: 403, kind: "forbidden" },
        );
      }
      if (response.status === 404) {
        throw new GoCdError(
          `Not found on this GoCD server (404). ${detail}`.trim(),
          {
            status: 404,
            kind: "missing",
          },
        );
      }
      throw new GoCdError(
        `GoCD returned ${response.status}. ${detail}`.trim(),
        {
          status: response.status,
        },
      );
    }

    if (raw) return { text, etag: response.headers.get("ETag") };

    if (!text.trim()) return { data: null, etag: response.headers.get("ETag") };
    try {
      return { data: JSON.parse(text), etag: response.headers.get("ETag") };
    } catch {
      throw new GoCdError(
        "GoCD sent something that is not JSON -- usually a proxy, a login page, or the wrong URL (it should end in /go).",
        { kind: "parse" },
      );
    }
  }

  // ---------------------------------------------------------------- reading

  /**
   * Groups, membership, pause state and latest-run status for every pipeline
   * the user can see, in one gzipped request. Pass the previous ETag and an
   * unchanged server answers 304, which skips the whole payload.
   */
  async dashboard({ etag = null, view = null } = {}) {
    // Built to match what GoCD's own dashboard sends, observed in DevTools
    // against a live server.
    //
    // `%20` for a space, not the `+` that URLSearchParams produces: Jetty very
    // likely accepts both, but if it did not the failure would be silent -- the
    // server would ignore the filter and return every pipeline on the instance,
    // visible only as a fat payload, since the local enforcement would still
    // show the right list.
    //
    // `allowEmpty` tells the server that a view matching nothing really means
    // nothing, rather than falling back to the unfiltered dashboard. Without it
    // an empty view is the most expensive request the extension can make.
    const query = view
      ? `?viewName=${encodeURIComponent(view)}&allowEmpty=true`
      : "";
    const headers = etag ? { "If-None-Match": etag } : {};
    const res = await this.#send("GET", `/api/dashboard${query}`, {
      version: 4,
      headers,
    });
    if (res.notModified) return { notModified: true, etag: res.etag || etag };
    const embedded = res.data?._embedded || {};
    return {
      etag: res.etag,
      groups: embedded.pipeline_groups || [],
      pipelines: embedded.pipelines || [],
    };
  }

  /** One page of run history, newest first. `after` is the cursor from the previous page. */
  async history(pipeline, { after = null } = {}) {
    const query = after == null ? "" : `?after=${encodeURIComponent(after)}`;
    const { data } = await this.#send(
      "GET",
      `/api/pipelines/${encodeSegment(pipeline)}/history${query}`,
      { version: 1 },
    );
    return {
      runs: data?.pipelines || [],
      next: nextPageCursor(data?._links?.next?.href),
    };
  }

  async instance(pipeline, counter) {
    const { data } = await this.#send(
      "GET",
      `/api/pipelines/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}`,
      { version: 1 },
    );
    return data;
  }

  /**
   * One specific attempt of a stage, with the jobs that ran in it.
   *
   * The run history only ever carries a stage's *latest* instance, so once a
   * stage has been re-run the attempt before it is invisible there -- and that
   * is usually the interesting one, because it is why the re-run happened. The
   * file server keeps every attempt's logs; this is what names the jobs to ask
   * for. A re-run of selected jobs carries the others over, so two attempts of
   * the same stage do not necessarily hold the same set of jobs.
   */
  async stageInstance(pipeline, counter, stage, stageCounter) {
    const { data } = await this.#send(
      "GET",
      `/api/stages/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}` +
        `/${encodeSegment(stage)}/${encodeSegment(stageCounter)}`,
      { version: 3 },
    );
    return data;
  }

  /**
   * The user's personalized dashboard views -- the same tabs as the web UI.
   *
   * THE ONE UNDOCUMENTED ENDPOINT IN THIS CLIENT. `/api/internal/*` is named
   * internal because it is coupled to GoCD's own UI: no contract, no version
   * guarantee, removable without notice. A GoCD maintainer has said as much
   * about this exact endpoint, and he is right.
   *
   * It stays only because it is a read, and because losing it costs nothing but
   * the feature it serves: the caller catches the failure and carries on with
   * `viewsAvailable = false`, and the two built-in views filter client-side and
   * never come here at all. Nothing else in the product depends on it.
   *
   * If GoCD ever documents a way to read a user's dashboard views, this should
   * move to it the same day.
   */
  async views() {
    const { data, etag } = await this.#send(
      "GET",
      "/api/internal/pipeline_selection",
      {
        version: 1,
      },
    );
    return {
      filters: data?.filters || [],
      etag: etag ? etag.replace("--gzip", "") : null,
    };
  }

  /** Artifact tree for one job, from the plain file-server .json listing. */
  async artifacts(pipeline, counter, stage, stageCounter, job) {
    const path =
      `/files/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}` +
      `/${encodeSegment(stage)}/${encodeSegment(stageCounter)}/${encodeSegment(job)}.json`;
    const { data } = await this.#send("GET", path, {});
    return data || [];
  }

  /**
   * Raw job console output. Not part of the versioned JSON API -- a plain text
   * file endpoint that works while the job is still running. `startLine` is
   * 0-based, so tailing appends instead of re-downloading the whole log.
   */
  async consoleLog(pipeline, counter, stage, stageCounter, job, startLine = 0) {
    let path =
      `/files/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}` +
      `/${encodeSegment(stage)}/${encodeSegment(stageCounter)}/${encodeSegment(job)}` +
      `/cruise-output/console.log`;
    if (startLine > 0) path += `?startLineNumber=${startLine}`;
    const { text } = await this.#send("GET", path, { raw: true });
    return text;
  }

  async currentUser() {
    const { data } = await this.#send("GET", "/api/current_user", {
      version: 1,
    });
    return data;
  }

  async version() {
    const { data } = await this.#send("GET", "/api/version", { version: 1 });
    return data;
  }

  // --------------------------------------------------------------- writing

  /**
   * X-GoCD-Confirm marks these as deliberate API calls rather than a browser
   * form post, which is what GoCD's CSRF guard is looking for.
   */
  #mutate(path, { version, body }) {
    const headers = { "X-GoCD-Confirm": "true" };
    if (body) headers["Content-Type"] = "application/json";
    return this.#send("POST", path, { version, headers, body });
  }

  async trigger(pipeline, environmentVariables = []) {
    const body =
      environmentVariables.length > 0
        ? JSON.stringify({
            environment_variables: environmentVariables.map(
              ({ name, value }) => ({
                name,
                value,
                secure: false,
              }),
            ),
            update_materials_before_scheduling: true,
          })
        : "{}";
    await this.#mutate(`/api/pipelines/${encodeSegment(pipeline)}/schedule`, {
      version: 1,
      body,
    });
  }

  async pause(pipeline, cause) {
    await this.#mutate(`/api/pipelines/${encodeSegment(pipeline)}/pause`, {
      version: 1,
      body: JSON.stringify({ pause_cause: cause || "Paused from GoCD Lens" }),
    });
  }

  async unpause(pipeline) {
    await this.#mutate(`/api/pipelines/${encodeSegment(pipeline)}/unpause`, {
      version: 1,
    });
  }

  async cancelStage(pipeline, counter, stage, stageCounter) {
    await this.#stageVerb(pipeline, counter, stage, stageCounter, "cancel");
  }

  async rerunFailedJobs(pipeline, counter, stage, stageCounter) {
    await this.#stageVerb(
      pipeline,
      counter,
      stage,
      stageCounter,
      "run-failed-jobs",
    );
  }

  /**
   * Run a whole stage again.
   *
   * The odd one out, and deliberately not `#stageVerb`. GoCD serves this from
   * StageOperationsControllerV2 -- **v2, and no stage counter in the path** --
   * while cancel, run-failed-jobs and run-selected-jobs come from
   * StageInstanceControllerV3. That is consistent once you see it: re-running a
   * stage *creates* the next attempt, so there is no attempt to address, while
   * the other three act on one that exists.
   *
   * Sending this the v3 shape is a 404 on the path and a 406 on the version,
   * which is how "Re-run" could fail while "Re-run selected (n)" worked --
   * different endpoint, different controller.
   */
  async rerunStage(pipeline, counter, stage) {
    const path =
      `/api/stages/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}` +
      `/${encodeSegment(stage)}/run`;
    await this.#mutate(path, { version: 2 });
  }

  /**
   * Re-run named jobs only. A stage with a dozen parallel jobs is common, and
   * re-running all of them to retry one flaky job wastes agents and minutes.
   */
  async rerunSelectedJobs(pipeline, counter, stage, stageCounter, jobs) {
    const path =
      `/api/stages/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}` +
      `/${encodeSegment(stage)}/${encodeSegment(stageCounter)}/run-selected-jobs`;
    await this.#mutate(path, { version: 3, body: JSON.stringify({ jobs }) });
  }

  /** Verbs that act on one existing attempt, and so carry its counter. */
  #stageVerb(pipeline, counter, stage, stageCounter, verb) {
    const path =
      `/api/stages/${encodeSegment(pipeline)}/${encodeURIComponent(counter)}` +
      `/${encodeSegment(stage)}/${encodeSegment(stageCounter)}/${verb}`;
    return this.#mutate(path, { version: 3 });
  }

  // -------------------------------------------------------------- web links

  /** Where the GoCD web UI would have shown this, for the "open in GoCD" links. */
  webUrl(kind, parts = {}) {
    const { pipeline, counter, stage, stageCounter, job } = parts;
    switch (kind) {
      case "pipeline":
        return `${this.base}/pipeline/activity/${encodeSegment(pipeline)}`;
      case "run":
        return `${this.base}/pipelines/value_stream_map/${encodeSegment(pipeline)}/${counter}`;
      case "stage":
        return `${this.base}/pipelines/${encodeSegment(pipeline)}/${counter}/${encodeSegment(stage)}/${encodeSegment(stageCounter)}`;
      case "job":
        return `${this.base}/tab/build/detail/${encodeSegment(pipeline)}/${counter}/${encodeSegment(stage)}/${encodeSegment(stageCounter)}/${encodeSegment(job)}`;
      default:
        return this.base;
    }
  }
}

/**
 * The match pattern this extension must hold to talk to a server. Optional host
 * permissions are declared broadly in the manifest but granted one origin at a
 * time, at the moment the user saves a connection.
 */
export function originPattern(serverUrl) {
  const url = new URL(serverUrl);
  return `${url.protocol}//${url.host}/*`;
}

/** Cursor for the next history page, parsed from _links.next.href's ?after=<n>. */
export function nextPageCursor(href) {
  if (!href) return null;
  const query = String(href).split("?")[1];
  if (!query) return null;
  const after = new URLSearchParams(query).get("after");
  if (after == null) return null;
  const n = Number(after);
  return Number.isSafeInteger(n) ? n : null;
}
