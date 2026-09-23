/**
 * The pure helpers: status rollups, search, time, and the parsers that turn
 * GoCD's free-text material descriptions into something safe to put in a URL.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  STATUS,
  rollup,
  stageStatus,
  pipelineStatus,
  runStatus,
  jobStatus,
  isActive,
  fuzzyMatch,
  matchScore,
  parseGitMaterial,
  gitRefs,
  upstreamDeps,
  commitUrl,
  flattenArtifacts,
  parseLogLine,
  timeAgo,
  runScheduledAt,
  duration,
} from "../src/lib/status.js";

const ESC = String.fromCharCode(27);

test("rollup reports the worst status across stages", () => {
  assert.equal(rollup(["Passed", "Passed"]), "Passed");
  assert.equal(rollup(["Passed", "Building"]), "Building");
  assert.equal(rollup(["Passed", "Cancelled"]), "Cancelled");
  assert.equal(
    rollup(["Cancelled", "Failed"]),
    "Failed",
    "a failure outranks a cancellation",
  );
  assert.equal(
    rollup(["Scheduled"]),
    "Building",
    "scheduled work is work in flight",
  );
});

test("rollup does not call a never-run pipeline green", () => {
  assert.equal(rollup([]), "Unknown");
  assert.equal(rollup([undefined]), "Unknown");
  assert.equal(
    rollup([null, undefined]),
    "Unknown",
    "nothing known about any stage",
  );
});

// Reported in use twice, from opposite directions: this shape first read as
// "Never run", then as "In progress". It is neither.
test("a run that stopped part-way with everything passing is Passed", () => {
  // The shape of a pipeline held at a manual approval gate: the last stage
  // simply never started. GoCD shows that green too, and the grey segment in
  // the stage strip is where "and no further" gets said.
  assert.equal(rollup(["Passed", "Unknown"]), "Passed");
  assert.equal(rollup(["Passed", undefined]), "Passed");
  assert.equal(rollup(["Passed", "Passed", "Unknown"]), "Passed");
});

test("a stage still running outranks one that has not started", () => {
  assert.equal(rollup(["Passed", "Building", "Unknown"]), "Building");
  assert.equal(
    rollup(["Passed", "Failed", "Unknown"]),
    "Failed",
    "a failure is still the headline",
  );
});

test("a stage building right now outranks a stage that failed", () => {
  // GoCD stops a run at the stage that failed, so a later stage can only be
  // moving because someone re-ran the failed one -- and then the pipeline is
  // being worked on, not sitting broken. Reading it as failed left the badge
  // red with nothing to count while the pipeline page said "Building".
  assert.equal(rollup(["Passed", "Failed", "Building"]), "Building");
  assert.equal(
    rollup(["Failed", "Scheduled"]),
    "Building",
    "queued work is work in flight",
  );
  assert.equal(rollup(["Cancelled", "Building"]), "Building");
  // And with nothing moving, the failure is still the headline.
  assert.equal(rollup(["Passed", "Failed", "Cancelled"]), "Failed");
});

test("nothing known about any stage is still never-run", () => {
  assert.equal(rollup(["Unknown", "Unknown"]), "Unknown");
  assert.equal(rollup([undefined, null]), "Unknown");
});

test("dashboard entries and history entries roll up the same way", () => {
  const dashboardEntry = {
    _embedded: {
      instances: [
        { _embedded: { stages: [{ status: "Passed" }, { status: "Failed" }] } },
      ],
    },
  };
  assert.equal(pipelineStatus(dashboardEntry), "Failed");
  assert.equal(
    runStatus({ stages: [{ status: "Passed" }, { status: "Failed" }] }),
    "Failed",
  );
});

test("a pipeline that has never run is Unknown, not an error", () => {
  assert.equal(pipelineStatus({ _embedded: { instances: [] } }), "Unknown");
  assert.equal(pipelineStatus({}), "Unknown");
  assert.equal(pipelineStatus(null), "Unknown");
});

test("a running job is reported by its state, not its stale result", () => {
  // GoCD leaves `result` as Unknown while a job runs; reading it alone would
  // show a live job as failed-ish rather than building.
  assert.equal(jobStatus({ state: "Building", result: "Unknown" }), "Building");
  assert.equal(
    jobStatus({ state: "Scheduled", result: "Unknown" }),
    "Scheduled",
  );
  assert.equal(jobStatus({ state: "Completed", result: "Failed" }), "Failed");
  assert.equal(jobStatus({ state: "Completed", result: "Passed" }), "Passed");
  assert.equal(jobStatus({}), "Unknown");
});

// Reported in use: a pipeline showed as running in the list but as never-run
// once opened. The list reads /api/dashboard and the detail page reads
// /api/pipelines/:name/history, and the two describe a stage differently.
test("a stage is read as running whichever field the endpoint used", () => {
  // How the dashboard says it.
  assert.equal(stageStatus({ name: "build", status: "Building" }), "Building");
  // How a history entry can say it.
  assert.equal(stageStatus({ name: "build", result: "Building" }), "Building");
  // And when neither is set, the jobs are the only thing still talking.
  assert.equal(
    stageStatus({
      name: "build",
      jobs: [{ name: "compile", state: "Building", result: "Unknown" }],
    }),
    "Building",
  );
  assert.equal(
    stageStatus({
      name: "build",
      jobs: [{ name: "compile", state: "Scheduled" }],
    }),
    "Building",
    "a queued job means the stage has not finished",
  );
});

test("a finished stage is read from its jobs when no status field arrives", () => {
  const completed = (result) => ({
    name: "compile",
    state: "Completed",
    result,
  });
  assert.equal(
    stageStatus({ jobs: [completed("Passed"), completed("Passed")] }),
    "Passed",
  );
  assert.equal(
    stageStatus({ jobs: [completed("Passed"), completed("Failed")] }),
    "Failed",
  );
  assert.equal(stageStatus({ jobs: [completed("Cancelled")] }), "Cancelled");
});

test("a stage with nothing to go on stays Unknown rather than guessing green", () => {
  assert.equal(stageStatus({ name: "deploy" }), "Unknown");
  assert.equal(stageStatus({ name: "deploy", jobs: [] }), "Unknown");
  assert.equal(stageStatus({ name: "deploy", result: "Unknown" }), "Unknown");
  assert.equal(stageStatus(null), "Unknown");
});

// The second half of the same report: the stage said "Unknown" while one of
// its jobs was plainly still building.
test('a literal "Unknown" status does not shadow what the jobs are doing', () => {
  assert.equal(
    stageStatus({
      name: "e2e-groups",
      status: "Unknown",
      result: "Unknown",
      jobs: [
        { name: "zod", state: "Completed", result: "Passed" },
        { name: "rest", state: "Building", result: "Unknown" },
      ],
    }),
    "Building",
    '"Unknown" is the absence of an answer, not an answer',
  );

  assert.equal(
    stageStatus({
      name: "sanity",
      status: "Unknown",
      jobs: [{ name: "sanity", state: "Completed", result: "Failed" }],
    }),
    "Failed",
  );
});

test("the run header agrees with the job that is still running", () => {
  // End to end: the exact shape that was showing "Never run" at the top.
  const run = {
    stages: [
      {
        name: "setup",
        status: "Passed",
        jobs: [{ state: "Completed", result: "Passed" }],
      },
      {
        name: "e2e-groups",
        status: "Unknown",
        jobs: [
          { name: "zod", state: "Completed", result: "Passed" },
          { name: "rest", state: "Building" },
        ],
      },
      { name: "sanity", status: "Unknown" },
    ],
  };
  assert.equal(runStatus(run), "Building");
});

test("a declared status wins over what the jobs imply", () => {
  // The server's own word is more authoritative than our inference.
  assert.equal(
    stageStatus({ status: "Cancelled", jobs: [{ state: "Building" }] }),
    "Cancelled",
  );
});

test("a run rolls up to Building from either endpoint shape", () => {
  const fromDashboard = {
    stages: [{ status: "Passed" }, { status: "Building" }],
  };
  const fromHistory = {
    stages: [
      { result: "Passed", jobs: [{ state: "Completed", result: "Passed" }] },
      { result: "Unknown", jobs: [{ state: "Building", result: "Unknown" }] },
    ],
  };
  assert.equal(runStatus(fromDashboard), "Building");
  assert.equal(
    runStatus(fromHistory),
    "Building",
    "the same run must not read differently once opened",
  );
});

test("every status a view can be handed has a label and a tone", () => {
  // Views look statuses up in this table; a miss renders as "Never run", which
  // is wrong for a job that is merely queued.
  const produced = [
    "Passed",
    "Failed",
    "Cancelled",
    "Building",
    "Scheduled",
    "Unknown",
  ];
  for (const status of produced) {
    assert.ok(STATUS[status], `${status} has no entry`);
    assert.ok(STATUS[status].label && STATUS[status].tone);
  }
  assert.equal(
    STATUS.Scheduled.tone,
    "build",
    "queued work should read as in-flight, not idle",
  );
});

test("only running and scheduled stages count as active", () => {
  assert.ok(isActive("Building"));
  assert.ok(isActive("Scheduled"));
  for (const done of ["Passed", "Failed", "Cancelled", "Unknown", undefined]) {
    assert.ok(!isActive(done), `${done} should not be active`);
  }
});

test("fuzzy search matches initials and reports where it matched", () => {
  assert.deepEqual(fuzzyMatch("wabp", "web-app-build-prod"), [0, 4, 8, 14]);
  assert.deepEqual(
    fuzzyMatch("", "anything"),
    [],
    "an empty query matches everything",
  );
  assert.equal(fuzzyMatch("zzz", "web-app"), null);
  assert.equal(fuzzyMatch("ppa", "web-app"), null, "order matters");
});

test("a contiguous match ranks above a scattered one", () => {
  assert.ok(
    matchScore("build", "web-build") < matchScore("build", "b-u-i-l-d-x"),
  );
  assert.equal(matchScore("nope", "web-app"), null);
});

test("git material descriptions parse in both SSH and HTTPS forms", () => {
  assert.deepEqual(
    parseGitMaterial("URL: git@github.com:acme/web-app.git, Branch: main"),
    {
      host: "github.com",
      owner: "acme",
      repo: "web-app",
      branch: "main",
    },
  );
  assert.deepEqual(
    parseGitMaterial(
      "URL: https://ghe.corp.io/platform/deploy, Branch: release",
    ),
    {
      host: "ghe.corp.io",
      owner: "platform",
      repo: "deploy",
      branch: "release",
    },
  );
  assert.deepEqual(
    parseGitMaterial(
      "URL: https://ghe.corp.io/platform/deploy.git, Branch: release",
    ),
    {
      host: "ghe.corp.io",
      owner: "platform",
      repo: "deploy",
      branch: "release",
    },
  );
  assert.equal(
    parseGitMaterial("URL: git@github.com:acme/web.git").branch,
    "main",
    "branch defaults",
  );
});

test("a hostile material description is dropped rather than escaped", () => {
  // These strings come from the server and end up inside a URL that gets handed
  // to the browser, so anything outside the safe character sets is refused.
  for (const hostile of [
    "URL: https://github.com&calc/acme/web-app, Branch: main",
    "URL: https://github.com/acme/web app, Branch: main",
    "URL: https://github.com/../../etc/passwd, Branch: main",
    "URL: javascript:alert(1)/a/b, Branch: main",
    "URL: /local/bare/repo.git, Branch: main",
    "URL: https://host/only-owner, Branch: x",
    "no url here",
    "",
    null,
  ]) {
    assert.equal(parseGitMaterial(hostile), null, `accepted ${hostile}`);
  }
});

test("git refs come out of a build cause, skipping non-git materials", () => {
  const run = {
    build_cause: {
      material_revisions: [
        {
          material: {
            type: "Git",
            description: "URL: git@github.com:acme/web.git, Branch: main",
          },
          modifications: [
            { revision: "abc123", user_name: "Dev <d@e.f>", comment: "fix it" },
          ],
        },
        {
          material: { type: "Pipeline", description: "upstream [ build ]" },
          modifications: [],
        },
        {
          material: {
            type: "Git",
            description: "URL: https://ghe.corp.io/p/deploy, Branch: release",
          },
          modifications: [{ revision: "def456" }],
        },
      ],
    },
  };
  const refs = gitRefs(run);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].repo, "web");
  assert.equal(refs[0].sha, "abc123");
  assert.equal(refs[1].branch, "release");
  assert.equal(commitUrl(refs[0]), "https://github.com/acme/web/commit/abc123");
});

test("a revision with a hostile SHA is skipped", () => {
  const run = {
    build_cause: {
      material_revisions: [
        {
          material: {
            type: "Git",
            description: "URL: git@github.com:a/b.git, Branch: main",
          },
          modifications: [{ revision: "../../../etc/passwd" }],
        },
      ],
    },
  };
  assert.deepEqual(gitRefs(run), []);
});

test("upstream dependencies are read from Pipeline material revisions", () => {
  // A deploy pipeline usually has no git material at all; its commit is one hop
  // away, behind a revision that reads "name/counter/stage/counter".
  const withDep = (revision) => ({
    build_cause: {
      material_revisions: [
        { material: { type: "Pipeline" }, modifications: [{ revision }] },
      ],
    },
  });
  assert.deepEqual(upstreamDeps(withDep("my-build/389/lint-test/1")), [
    { name: "my-build", counter: 389 },
  ]);
  for (const bad of ["no-slashes", "name/notanumber/stage/1", "/389/stage/1"]) {
    assert.deepEqual(
      upstreamDeps(withDep(bad)),
      [],
      `${bad} should not yield a dependency`,
    );
  }
  assert.deepEqual(upstreamDeps({}), []);
});

test("artifact folders stay closed until they are opened", () => {
  const tree = [
    {
      name: "dist",
      type: "folder",
      files: [
        { name: "app.tar.gz", type: "file", url: "https://x/app.tar.gz" },
        {
          name: "maps",
          type: "folder",
          files: [{ name: "a.map", type: "file", url: "https://x/a.map" }],
        },
      ],
    },
  ];

  assert.equal(
    flattenArtifacts(tree, new Set()).length,
    1,
    "a deep tree must not render all at once",
  );

  const oneOpen = flattenArtifacts(tree, new Set(["dist"]));
  assert.deepEqual(
    oneOpen.map((r) => [r.depth, r.name, r.isFolder]),
    [
      [0, "dist", true],
      [1, "app.tar.gz", false],
      [1, "maps", true],
    ],
  );

  const bothOpen = flattenArtifacts(tree, new Set(["dist", "dist/maps"]));
  assert.equal(bothOpen.length, 4);
  assert.equal(bothOpen[3].path, "dist/maps/a.map");
});

test("identically named folders under different parents keep separate state", () => {
  const branch = (name) => ({
    name,
    type: "folder",
    files: [
      {
        name: "logs",
        type: "folder",
        files: [{ name: "a.txt", type: "file", url: "u" }],
      },
    ],
  });
  const rows = flattenArtifacts(
    [branch("one"), branch("two")],
    new Set(["one", "one/logs", "two"]),
  );
  const open = Object.fromEntries(rows.map((r) => [r.path, r.expanded]));
  assert.equal(open["one/logs"], true);
  assert.equal(open["two/logs"], false);
});

test("a node with children is a folder even without a type", () => {
  const rows = flattenArtifacts(
    [{ name: "untyped", files: [{ name: "inner.txt" }] }],
    new Set(),
  );
  assert.equal(
    rows[0].isFolder,
    true,
    "otherwise its children would be unreachable",
  );
});

test("console lines drop the stream marker and keep the timestamp", () => {
  const framed = parseLogLine("in|10:21:33.123 Building project");
  assert.equal(framed.time, "10:21:33.123");
  assert.equal(framed.body, "Building project");

  const unframed = parseLogLine("a plain line");
  assert.equal(unframed.time, null);
  assert.equal(unframed.body, "a plain line");
});

test("ANSI colouring from the build is stripped, not shown raw", () => {
  const line = parseLogLine(`${ESC}[31mFAILED${ESC}[0m`);
  assert.equal(line.body, "FAILED");
  assert.ok(!line.body.includes(ESC));

  const framedAndColoured = parseLogLine(
    `er|10:00:00.000 ${ESC}[1;33mwarning: x${ESC}[0m`,
  );
  assert.equal(framedAndColoured.body, "warning: x");
  assert.equal(framedAndColoured.severity, "warn");
});

test("severity colouring keys off words, and a carriage return does not survive", () => {
  assert.equal(parseLogLine("ERROR: it broke").severity, "error");
  assert.equal(parseLogLine("Exception in thread main").severity, "error");
  assert.equal(parseLogLine("warning: deprecated call").severity, "warn");
  assert.equal(parseLogLine("BUILD SUCCESS").severity, "ok");
  assert.equal(parseLogLine("just some output").severity, "plain");
  assert.equal(parseLogLine("trailing\r").body, "trailing");
});

test("relative times read the way a person would say them", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(timeAgo(now - 5_000, now), "just now");
  assert.equal(timeAgo(now - 5 * 60_000, now), "5m ago");
  assert.equal(timeAgo(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(timeAgo(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(
    timeAgo(0, now),
    "",
    "a missing timestamp shows nothing rather than 1970",
  );
  assert.equal(
    timeAgo(now + 60_000, now),
    "just now",
    "clock skew must not read as negative",
  );
});

/**
 * The card and the pipeline page must answer "when did this run" with the same
 * moment. They read different endpoints, so this is the seam where they agreed
 * to disagree: a card said "just now" over a run the page dated eight days ago.
 */
test("a card reads the run its own schedule time, not its stages", () => {
  const run = {
    scheduled_at: "2026-09-15T13:10:00.000Z",
    _embedded: {
      stages: [
        { name: "build", scheduled_at: "2026-09-15T13:10:00.000Z" },
        // Re-run this morning. It is the newest thing here and the most
        // misleading: the run it belongs to is still eight days old.
        { name: "test", scheduled_at: "2026-09-23T09:00:00.000Z" },
      ],
    },
  };
  assert.equal(runScheduledAt(run), Date.parse("2026-09-15T13:10:00.000Z"));
});

test("without a run timestamp, the first stage stands in -- never the last", () => {
  const run = {
    _embedded: {
      stages: [
        { name: "build", scheduled_at: "2026-09-15T13:10:00.000Z" },
        { name: "test", scheduled_at: "2026-09-23T09:00:00.000Z" },
      ],
    },
  };
  assert.equal(
    runScheduledAt(run),
    Date.parse("2026-09-15T13:10:00.000Z"),
    'a stage re-run must not drag the run forward to "just now"',
  );
});

test("a run timestamp is read whether it arrives as millis or as a string", () => {
  // The dashboard sends ISO strings; the history endpoint sends epoch millis.
  const millis = Date.parse("2026-09-15T13:10:00.000Z");
  assert.equal(runScheduledAt({ scheduled_date: millis }), millis);
  assert.equal(
    runScheduledAt({ scheduled_at: "2026-09-15T13:10:00.000Z" }),
    millis,
  );
  assert.equal(
    runScheduledAt({ stages: [{ scheduled_date: millis }] }),
    millis,
    "history shape too",
  );
});

test("a run with no usable timestamp shows nothing rather than 1970", () => {
  assert.equal(runScheduledAt(null), 0);
  assert.equal(runScheduledAt({}), 0);
  assert.equal(runScheduledAt({ scheduled_at: "not a date" }), 0);
  assert.equal(
    runScheduledAt({ _embedded: { stages: [{ name: "build" }] } }),
    0,
  );
  assert.equal(timeAgo(runScheduledAt({})), "");
});

test("durations are written in the largest useful unit", () => {
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(90_000), "1m 30s");
  assert.equal(duration(120_000), "2m");
  assert.equal(duration(3_900_000), "1h 5m");
  assert.equal(duration(0), "");
  assert.equal(duration(-5), "");
});
