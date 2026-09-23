/**
 * Pure helpers shared by the service worker and every page: status rollups,
 * fuzzy matching, time formatting, and the bits of GoCD's data model that need
 * interpreting rather than displaying.
 */

export const STATUS = {
  Failed: { label: "Failed", tone: "fail", rank: 0 },
  Cancelled: { label: "Cancelled", tone: "cancel", rank: 1 },
  Building: { label: "Building", tone: "build", rank: 2 },
  // Not produced by `rollup`, but `jobStatus` and raw stage statuses both use
  // it, and a queued job showing as "Never run" reads as a bug.
  Scheduled: { label: "Queued", tone: "build", rank: 2 },
  Passed: { label: "Passed", tone: "pass", rank: 3 },
  Unknown: { label: "Never run", tone: "idle", rank: 4 },
};

/**
 * Building > Failed > Cancelled > Passed > Unknown.
 *
 * Live work outranks a failure, which is not the obvious order -- a failure is
 * the louder fact -- but the state where both are true only happens one way.
 * GoCD halts a run at the stage that failed, so a later stage cannot be moving
 * unless somebody re-ran the failed one, and then the honest answer to "what is
 * this pipeline doing" is *building*: the failure is being dealt with, and the
 * red segment still sits in the stage strip saying it happened.
 *
 * Ordering it the other way made the product disagree with itself. The pipeline
 * page read the run as building, off the history endpoint; the list, the tiles
 * and the badge read it as failed, off the dashboard payload; and the badge --
 * which counts running before failing precisely so it can answer "is anything
 * happening now" -- had nothing to count, so it sat red on a pipeline that was
 * visibly in flight.
 *
 * The subtle case is a run that stopped part-way with everything it did run
 * having passed -- the normal shape of a pipeline held at a manual approval
 * gate, where the last stage simply never started. That is `Passed`, not
 * in-progress and not never-run: it is green as far as it got, which is what
 * GoCD's own dashboard shows, and the grey segment in the stage strip is where
 * the "and no further" is said. Only a run with nothing known about any stage
 * is really `Unknown`.
 */
export function rollup(statuses) {
  let anyBuilding = false;
  let anyFailed = false;
  let anyCancelled = false;
  let anyPassed = false;

  for (const status of statuses) {
    switch (status) {
      case "Passed":
        anyPassed = true;
        break;
      case "Failed":
        anyFailed = true;
        break;
      case "Cancelled":
        anyCancelled = true;
        break;
      case "Building":
      case "Scheduled":
        anyBuilding = true;
        break;
      default:
        break;
    }
  }

  if (anyBuilding) return "Building";
  if (anyFailed) return "Failed";
  if (anyCancelled) return "Cancelled";
  if (anyPassed) return "Passed";
  return "Unknown";
}

/**
 * The status of one stage, whichever endpoint it came from.
 *
 * `/api/dashboard` and `/api/pipelines/:name/history` do not describe a stage
 * the same way: the dashboard always sets `status`, while a history entry can
 * carry `result` instead, and a stage that is mid-flight can arrive with
 * neither -- its jobs are the only thing that say it is alive. Reading just one
 * field is why a pipeline could show as running in the list and as never-run
 * once you opened it.
 */
export function stageStatus(stage) {
  if (!stage) return "Unknown";

  // GoCD sends the *string* "Unknown" for a stage it has nothing to say about,
  // and that is not an answer -- it must not shadow the jobs, which may well be
  // building. This is how a stage with a running job read as never-run.
  const declared = [stage.status, stage.result].find(
    (value) => value && value !== "Unknown",
  );
  if (declared) return declared;

  const jobs = stage.jobs || [];
  if (jobs.length === 0) return "Unknown";
  // A job that has not completed is proof the stage is still going.
  if (jobs.some((job) => job.state && job.state !== "Completed"))
    return "Building";
  if (jobs.some((job) => job.result === "Failed")) return "Failed";
  if (jobs.some((job) => job.result === "Cancelled")) return "Cancelled";
  if (jobs.every((job) => job.result === "Passed")) return "Passed";
  return "Unknown";
}

/** Rollup for a dashboard pipeline entry (its most recent run). */
export function pipelineStatus(pipeline) {
  const instance = pipeline?._embedded?.instances?.[0];
  if (!instance) return "Unknown";
  return rollup((instance._embedded?.stages || []).map(stageStatus));
}

/** Rollup for a history entry from /api/pipelines/:name/history. */
export function runStatus(run) {
  return rollup((run?.stages || []).map(stageStatus));
}

/** Running right now, and therefore cancellable. */
export function isActive(status) {
  return status === "Building" || status === "Scheduled";
}

export function jobStatus(job) {
  if (job?.state && job.state !== "Completed") {
    return job.state === "Scheduled" ? "Scheduled" : "Building";
  }
  if (job?.result === "Passed") return "Passed";
  if (job?.result === "Cancelled") return "Cancelled";
  if (job?.result === "Failed") return "Failed";
  return "Unknown";
}

// --------------------------------------------------------------------- time

/**
 * When a run happened, as the dashboard payload tells it.
 *
 * A run instance carries its own schedule time, and it is the same moment the
 * history endpoint calls `scheduled_date` -- so reading it is what stops a card
 * and the pipeline page disagreeing about one run.
 *
 * Without it, the *first* stage is the fallback, because a stage starts with
 * the run it belongs to. The newest stage start is a different question: re-run
 * one stage and that becomes "just now" while the run it belongs to is a week
 * old, which is exactly how a card came to read "just now" beside a page
 * reading "8d ago".
 */
/** The run a dashboard entry is describing: its most recent one. */
export function latestRun(pipeline) {
  return pipeline?._embedded?.instances?.[0] || null;
}

export function runScheduledAt(run) {
  const own = epochOf(run?.scheduled_at ?? run?.scheduled_date);
  if (own) return own;

  const stages = run?._embedded?.stages || run?.stages || [];
  const times = stages
    .map((stage) => epochOf(stage?.scheduled_at ?? stage?.scheduled_date))
    .filter(Boolean);
  return times.length ? Math.min(...times) : 0;
}

/** The dashboard sends an ISO string where the history endpoint sends millis. */
function epochOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function timeAgo(epochMillis, now = Date.now()) {
  if (!epochMillis) return "";
  const seconds = Math.max(0, Math.round((now - epochMillis) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Like `timeAgo`, but counts seconds. The "updated ..." label is the one thing
 * on screen that tells you the data is live, so it has to visibly move rather
 * than sit on "just now" for the best part of a minute.
 */
export function freshnessAgo(epochMillis, now = Date.now()) {
  if (!epochMillis) return "";
  const seconds = Math.max(0, Math.round((now - epochMillis) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function duration(ms) {
  if (!ms || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function absoluteTime(epochMillis) {
  if (!epochMillis) return "";
  return new Date(epochMillis).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ------------------------------------------------------------------ search

/**
 * Subsequence match, so `wabp` finds `web-app-build-prod`. Returns the matched
 * character positions for highlighting, or null when it does not match.
 */
export function fuzzyMatch(needle, haystack) {
  const query = needle.toLowerCase().trim();
  if (!query) return [];
  const text = haystack.toLowerCase();
  const positions = [];
  let at = 0;
  for (const ch of query) {
    if (ch === " ") continue;
    const found = text.indexOf(ch, at);
    if (found === -1) return null;
    positions.push(found);
    at = found + 1;
  }
  return positions;
}

/** A contiguous substring hit ranks above a scattered subsequence one. */
export function matchScore(needle, haystack) {
  const positions = fuzzyMatch(needle, haystack);
  if (positions === null) return null;
  if (positions.length === 0) return 0;
  const exact = haystack.toLowerCase().indexOf(needle.toLowerCase().trim());
  const spread = positions[positions.length - 1] - positions[0];
  return (exact === -1 ? 1000 : exact) + spread;
}

// ------------------------------------------------------------ git materials

const SAFE_HOST = /^[A-Za-z0-9.\-:]+$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._\-]+$/;

/**
 * GoCD's Git material description reads like
 * "URL: git@HOST:owner/repo.git, Branch: main". Everything parsed out of it is
 * server-supplied text that ends up inside a URL, so anything outside the safe
 * character sets is dropped rather than escaped.
 */
export function parseGitMaterial(description) {
  if (!description) return null;
  const afterUrl = String(description).split("URL: ")[1];
  if (!afterUrl) return null;
  const url = afterUrl.split(",")[0].trim();

  let host;
  let rest;
  if (url.startsWith("git@")) {
    [host, rest] = splitOnce(url.slice(4), ":");
  } else {
    const noScheme = url.replace(/^https?:\/\//, "");
    if (noScheme === url) return null;
    [host, rest] = splitOnce(noScheme, "/");
  }
  if (!host || !rest) return null;

  const trimmed = rest
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const [owner, repo] = splitOnce(trimmed, "/");
  if (!owner || !repo) return null;
  if (
    !SAFE_HOST.test(host) ||
    !SAFE_SEGMENT.test(owner) ||
    !SAFE_SEGMENT.test(repo)
  )
    return null;

  const branchAt = description.indexOf("Branch: ");
  const branch =
    branchAt === -1 ? "main" : description.slice(branchAt + 8).trim() || "main";
  return { host, owner, repo, branch };
}

function splitOnce(text, sep) {
  const at = text.indexOf(sep);
  if (at === -1) return [null, null];
  return [text.slice(0, at), text.slice(at + sep.length)];
}

/** Every direct Git material of a run, in material order. */
export function gitRefs(run) {
  const revisions = run?.build_cause?.material_revisions || [];
  const out = [];
  for (const revision of revisions) {
    if (revision.material?.type !== "Git") continue;
    const parsed = parseGitMaterial(revision.material?.description);
    if (!parsed) continue;
    const sha = revision.modifications?.[0]?.revision;
    if (!sha || !SAFE_SEGMENT.test(sha)) continue;
    out.push({ ...parsed, sha, modification: revision.modifications[0] });
  }
  return out;
}

/**
 * Upstream pipeline dependencies as {name, counter}. A deploy pipeline often
 * has no Git material at all -- its only input is a Pipeline material whose
 * revision reads "upstream-name/389/stage-name/1", so the commit is one hop away.
 */
export function upstreamDeps(run) {
  const revisions = run?.build_cause?.material_revisions || [];
  const out = [];
  for (const revision of revisions) {
    if (revision.material?.type !== "Pipeline") continue;
    const rev = revision.modifications?.[0]?.revision;
    if (!rev) continue;
    const [name, counterText] = rev.split("/");
    const counter = Number(counterText);
    if (name && Number.isSafeInteger(counter)) out.push({ name, counter });
  }
  return out;
}

export function commitUrl(ref) {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/commit/${ref.sha}`;
}

// ---------------------------------------------------------------- artifacts

/** Rows currently visible in the artifact tree, given the set of open folders. */
export function flattenArtifacts(
  nodes,
  expanded,
  depth = 0,
  prefix = "",
  out = [],
) {
  for (const node of nodes || []) {
    // GoCD marks folders with a type, but a node carrying children is one
    // regardless of what the type field says.
    const isFolder = node.type === "folder" || (node.files || []).length > 0;
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    const open = isFolder && expanded.has(path);
    out.push({
      depth,
      name: node.name,
      isFolder,
      url: node.url || null,
      path,
      expanded: open,
    });
    if (open) flattenArtifacts(node.files, expanded, depth + 1, path, out);
  }
  return out;
}

// --------------------------------------------------------------- log lines

/**
 * GoCD frames each console line as `xx|HH:MM:SS.mmm body`, where `xx` is a
 * stream marker. The marker is protocol rather than content, so it is dropped
 * and the timestamp kept. ANSI escapes from the build's own colouring are
 * stripped, because we are not rendering a terminal.
 */
const FRAME = /^([a-z]{2})\|(\d{2}:\d{2}:\d{2}\.\d{3})\s?(.*)$/i;
const ANSI = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;?]*[ -/]*[@-~]",
  "g",
);

export function parseLogLine(line) {
  const stripped = line.replace(ANSI, "").replace(/\r$/, "");
  const framed = FRAME.exec(stripped);
  const time = framed ? framed[2] : null;
  const body = framed ? framed[3] : stripped;
  return { time, body, severity: severityOf(body) };
}

function severityOf(body) {
  const text = body.toLowerCase();
  if (/(^|\W)(error|failed|failure|fatal|exception|panic)(\W|$)/.test(text))
    return "error";
  if (/(^|\W)(warn|warning|deprecated)(\W|$)/.test(text)) return "warn";
  if (/(^|\W)(success|succeeded|passed|up to date)(\W|$)/.test(text))
    return "ok";
  if (/^\s*\[go\]|^\s*\[agent\]/.test(text)) return "meta";
  return "plain";
}
