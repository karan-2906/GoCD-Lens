/**
 * The GoCD client, driven against a mock server that answers with the shapes a
 * real GoCD 23.5.0 does. These tests are the reason the extension can be
 * changed without a GoCD instance to hand: they pin the endpoints, the Accept
 * versions, the confirm header, the paging cursor and the tailing offset.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { GoCdClient, GoCdError, encodeSegment, nextPageCursor, originPattern } from '../src/lib/gocd.js';

let server;
let base;
/** Every request the mock server saw, so tests can assert on headers. */
let seen = [];

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const DASHBOARD = {
  _embedded: {
    pipeline_groups: [{ name: 'core', pipelines: ['web-app'] }],
    pipelines: [
      {
        name: 'web-app',
        pause_info: { paused: false },
        _embedded: {
          instances: [
            { counter: 42, label: '42', _embedded: { stages: [{ name: 'build', status: 'Failed' }] } },
          ],
        },
      },
    ],
  },
};

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname;

    if (path === '/go/api/dashboard') {
      if (req.headers['if-none-match'] === 'etag-1') return json(res, 304, '', { ETag: 'etag-1' });
      if (url.searchParams.get('viewName') === 'Mine') {
        return json(res, 200, { _embedded: { pipeline_groups: [], pipelines: [] } }, { ETag: 'etag-view' });
      }
      return json(res, 200, DASHBOARD, { ETag: 'etag-1' });
    }

    if (path === '/go/api/pipelines/web-app/history') {
      const after = url.searchParams.get('after');
      return json(res, 200, {
        _links: after ? {} : { next: { href: '/go/api/pipelines/web-app/history?after=41' } },
        pipelines: [
          {
            name: 'web-app',
            counter: after ? 41 : 42,
            label: after ? '41' : '42',
            scheduled_date: 1_700_000_000_000,
            stages: [
              {
                name: 'build',
                status: 'Failed',
                counter: '1',
                jobs: [{ name: 'compile', result: 'Failed', state: 'Completed' }],
              },
            ],
          },
        ],
      });
    }

    if (path === '/go/api/pipelines/web%2Fapp/history') {
      return json(res, 200, { pipelines: [{ name: 'web/app', counter: 1 }] });
    }

    if (path === '/go/api/pipelines/web-app/42') {
      return json(res, 200, { name: 'web-app', counter: 42, stages: [] });
    }

    // One attempt of a stage. The counter in the path is which attempt, so the
    // run's own payload (always the latest) cannot answer for an earlier one.
    if (req.method === 'GET' && /^\/go\/api\/stages\/web-app\/42\/integration\/\d+$/.test(path)) {
      return json(res, 200, {
        name: 'integration',
        counter: Number(path.split('/').pop()),
        result: 'Failed',
        jobs: [{ name: 'api-tests', state: 'Completed', result: 'Failed' }],
      });
    }

    if (req.method === 'POST' && path === '/go/api/pipelines/web-app/schedule') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      return req.on('end', () => {
        seen[seen.length - 1].body = body;
        json(res, 202, { message: 'Request to schedule pipeline accepted' });
      });
    }

    if (req.method === 'POST' && /\/go\/api\/pipelines\/web-app\/(pause|unpause)$/.test(path)) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      return req.on('end', () => {
        seen[seen.length - 1].body = body;
        json(res, 200, { message: 'ok' });
      });
    }

    if (req.method === 'POST' && /^\/go\/api\/stages\/web-app\/42\/build\/1\/(cancel|run|run-failed-jobs)$/.test(path)) {
      return json(res, 202, { message: 'accepted' });
    }

    if (req.method === 'POST' && path === '/go/api/stages/web-app/42/build/1/run-selected-jobs') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      return req.on('end', () => {
        seen[seen.length - 1].body = body;
        json(res, 202, { message: 'accepted' });
      });
    }

    if (path === '/go/files/web-app/42/build/1/compile.json') {
      return json(res, 200, [{ name: 'dist', type: 'folder', files: [] }]);
    }

    if (path === '/go/files/web-app/42/build/1/compile/cruise-output/console.log') {
      const start = Number(url.searchParams.get('startLineNumber') || 0);
      const lines = ['in|10:00:00.000 one', 'in|10:00:01.000 two', 'in|10:00:02.000 three'];
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(`${lines.slice(start).join('\n')}\n`);
    }

    if (path === '/go/api/internal/pipeline_selection') {
      if (req.method === 'PUT') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        return req.on('end', () => {
          seen[seen.length - 1].body = body;
          json(res, 200, { message: 'saved' });
        });
      }
      return json(res, 200, { filters: [{ name: 'Mine', type: 'whitelist', state: [], pipelines: ['web-app'] }] }, { ETag: 'sel-1--gzip' });
    }

    if (path === '/go/api/version') return json(res, 200, { version: '23.5.0' });
    if (path === '/go/api/current_user') return json(res, 200, { login_name: 'karan' });

    if (path === '/go/api/pipelines/missing/history') return json(res, 404, { message: 'Pipeline not found' });
    if (path === '/go/api/pipelines/denied/history') return json(res, 401, { message: 'not authorised' });
    if (path === '/go/api/pipelines/forbidden/history') return json(res, 403, { message: 'no permission' });
    if (path === '/go/api/pipelines/proxied/history') {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      return res.end('<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>');
    }
    if (path === '/go/api/pipelines/garbled/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('not json at all');
    }

    json(res, 404, { message: 'no route' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/go`;
});

after(() => server.close());

const tokenClient = () => new GoCdClient({ serverUrl: base, authMode: 'token', token: 'secret-token' });
const lastRequest = (pathStart) => seen.filter((r) => r.url.startsWith(pathStart)).pop();

test('a trailing slash on the server URL does not double up in paths', async () => {
  const client = new GoCdClient({ serverUrl: `${base}/`, authMode: 'session' });
  await client.version();
  assert.ok(lastRequest('/go/api/version'), 'expected /go/api/version, not /go//api/version');
});

test('the whole dashboard arrives in one call with the v4 Accept header', async () => {
  seen = [];
  const data = await tokenClient().dashboard({});
  assert.equal(data.pipelines.length, 1);
  assert.equal(data.groups[0].name, 'core');
  assert.equal(data.etag, 'etag-1');

  const request = lastRequest('/go/api/dashboard');
  assert.equal(request.headers.accept, 'application/vnd.go.cd.v4+json');
  assert.equal(request.headers.authorization, 'Bearer secret-token');
});

test('an unchanged dashboard costs a 304 instead of the payload', async () => {
  const result = await tokenClient().dashboard({ etag: 'etag-1' });
  assert.equal(result.notModified, true);
  assert.equal(result.etag, 'etag-1');
});

test('a personalized view is passed through as viewName', async () => {
  seen = [];
  await tokenClient().dashboard({ view: 'Mine' });
  assert.ok(lastRequest('/go/api/dashboard').url.includes('viewName=Mine'));
});

test('a view request says an empty view really is empty', async () => {
  // Otherwise a view matching nothing can fall back to the unfiltered
  // dashboard, which on a large instance is the most expensive request there is.
  seen = [];
  await tokenClient().dashboard({ view: 'Mine' });
  const params = new URL(lastRequest('/go/api/dashboard').url, 'http://x').searchParams;
  assert.equal(params.get('allowEmpty'), 'true');
  assert.equal(params.get('viewName'), 'Mine');
});

test('with no view there is no query string at all', async () => {
  seen = [];
  await tokenClient().dashboard({});
  assert.equal(lastRequest('/go/api/dashboard').url, '/go/api/dashboard');
});

test('a view name with a space is encoded the way GoCD encodes it', async () => {
  // Observed on a real server: its own dashboard requests
  // `viewName=Visual%20Builder`. URLSearchParams would send `Visual+Builder`,
  // and a server that does not decode `+` would silently ignore the filter and
  // return every pipeline on the instance.
  seen = [];
  await tokenClient().dashboard({ view: 'Visual Builder' });

  const { url } = lastRequest('/go/api/dashboard');
  assert.ok(url.includes('viewName=Visual%20Builder'), url);
  assert.ok(!url.includes('+'), `a space became a plus: ${url}`);

  // And the server must read back the name we meant.
  const decoded = new URL(url, 'http://x').searchParams.get('viewName');
  assert.equal(decoded, 'Visual Builder');
});

test('view names with other awkward characters survive the round trip', async () => {
  for (const name of ['R&D', 'team/platform', 'a b  c', 'caf\u00e9']) {
    seen = [];
    await tokenClient().dashboard({ view: name });
    const { url } = lastRequest('/go/api/dashboard');
    assert.equal(new URL(url, 'http://x').searchParams.get('viewName'), name, url);
  }
});

test('history pages forward using the cursor from _links.next', async () => {
  const client = tokenClient();
  const first = await client.history('web-app');
  assert.equal(first.runs[0].counter, 42);
  assert.equal(first.next, 41, 'the next cursor comes out of the link, not a guess');

  const second = await client.history('web-app', { after: first.next });
  assert.equal(second.runs[0].counter, 41);
  assert.equal(second.next, null, 'the last page must not loop forever');
});

test('a pipeline name with a slash stays inside one path segment', async () => {
  const runs = await tokenClient().history('web/app');
  assert.equal(runs.runs[0].name, 'web/app');
});

test('mutating calls carry X-GoCD-Confirm and the right API version', async () => {
  seen = [];
  const client = tokenClient();

  await client.trigger('web-app');
  const schedule = lastRequest('/go/api/pipelines/web-app/schedule');
  assert.equal(schedule.headers['x-gocd-confirm'], 'true', 'GoCD rejects these without it');
  assert.equal(schedule.headers.accept, 'application/vnd.go.cd.v1+json');
  assert.equal(schedule.body, '{}');

  await client.rerunFailedJobs('web-app', 42, 'build', '1');
  const rerun = lastRequest('/go/api/stages/web-app/42/build/1/run-failed-jobs');
  assert.equal(rerun.headers.accept, 'application/vnd.go.cd.v3+json', 'stage calls are v3');
  assert.equal(rerun.headers['x-gocd-confirm'], 'true');

  await client.cancelStage('web-app', 42, 'build', '1');
  assert.ok(lastRequest('/go/api/stages/web-app/42/build/1/cancel'));

  await client.rerunStage('web-app', 42, 'build', '1');
  assert.ok(lastRequest('/go/api/stages/web-app/42/build/1/run'));
});

test('triggering with variables sends them and asks for fresh materials', async () => {
  seen = [];
  await tokenClient().trigger('web-app', [{ name: 'DEPLOY_ENV', value: 'staging' }]);
  const body = JSON.parse(lastRequest('/go/api/pipelines/web-app/schedule').body);
  assert.deepEqual(body.environment_variables, [
    { name: 'DEPLOY_ENV', value: 'staging', secure: false },
  ]);
  assert.equal(body.update_materials_before_scheduling, true);
});

test('pausing sends a reason and unpausing sends no body', async () => {
  seen = [];
  const client = tokenClient();

  await client.pause('web-app', 'flaky agent');
  assert.deepEqual(JSON.parse(lastRequest('/go/api/pipelines/web-app/pause').body), {
    pause_cause: 'flaky agent',
  });

  await client.pause('web-app', '');
  assert.match(
    JSON.parse(lastRequest('/go/api/pipelines/web-app/pause').body).pause_cause,
    /GoCD Lens/,
    'an empty reason still gets something the rest of the team can read',
  );

  await client.unpause('web-app');
  const unpause = lastRequest('/go/api/pipelines/web-app/unpause');
  assert.equal(unpause.body, '', 'unpause takes no payload');
  assert.equal(unpause.headers['content-type'], undefined, 'and so declares no content type');
  assert.equal(unpause.headers['x-gocd-confirm'], 'true');
});

test('tailing asks only for the lines it has not already seen', async () => {
  const client = tokenClient();
  const whole = await client.consoleLog('web-app', 42, 'build', '1', 'compile', 0);
  assert.equal(whole.trim().split('\n').length, 3);

  const tail = await client.consoleLog('web-app', 42, 'build', '1', 'compile', 2);
  assert.equal(tail.trim().split('\n').length, 1);
  assert.match(tail, /three/, 'the tail must resume where the last fetch stopped');
});

test('a console log fetch at offset zero sends no cursor at all', async () => {
  seen = [];
  await tokenClient().consoleLog('web-app', 42, 'build', '1', 'compile', 0);
  const request = lastRequest('/go/files/web-app/42/build/1/compile/cruise-output/console.log');
  assert.ok(!request.url.includes('startLineNumber'));
  assert.ok(!request.headers.accept?.includes('vnd.go.cd'), 'the file server is not the versioned API');
});

test('an earlier attempt of a re-run stage is read from the stage instance', async () => {
  seen = [];
  const stage = await tokenClient().stageInstance('web-app', 42, 'integration', '1');

  const request = lastRequest('/go/api/stages/web-app/42/integration/1');
  assert.equal(request.method, 'GET', 'reading an attempt must not be one of the run verbs');
  assert.equal(request.headers.accept, 'application/vnd.go.cd.v3+json');
  assert.ok(!request.headers['x-gocd-confirm'], 'a read is not a mutation');
  assert.equal(stage.jobs[0].name, 'api-tests');
});

test('the attempt number is in the path, so attempts do not collapse into one', async () => {
  seen = [];
  const client = tokenClient();
  const first = await client.stageInstance('web-app', 42, 'integration', '1');
  const third = await client.stageInstance('web-app', 42, 'integration', '3');

  assert.equal(first.counter, 1);
  assert.equal(third.counter, 3, 'asking for attempt 3 must not answer with attempt 1');
});

test('the artifact listing comes from the file server, not the JSON API', async () => {
  const tree = await tokenClient().artifacts('web-app', 42, 'build', '1', 'compile');
  assert.equal(tree[0].name, 'dist');
});

// `/api/internal/*` is undocumented and uncontracted, so the client reads it
// and never writes to it. A write is the half that can corrupt a user's own
// dashboard configuration if the shape changes under us.
test('nothing in the client writes to an internal endpoint', async () => {
  seen = [];
  const client = tokenClient();
  await client.views();
  await client.dashboard();
  await client.history('web-app');

  const internal = seen.filter((r) => r.url.includes('/api/internal/'));
  assert.ok(internal.length > 0, 'views does read one, so this test is proving something');
  assert.deepEqual([...new Set(internal.map((r) => r.method))], ['GET']);
  assert.equal(typeof client.saveView, 'undefined', 'the write was removed, not just unwired');
});

test('errors are classified so the UI can say something a person can act on', async () => {
  const client = tokenClient();

  await assert.rejects(client.history('missing'), (err) => {
    assert.equal(err.kind, 'missing');
    assert.equal(err.status, 404);
    assert.match(err.message, /Pipeline not found/, 'GoCD’s own words are kept');
    return true;
  });

  await assert.rejects(client.history('denied'), (err) => {
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 401);
    return true;
  });

  await assert.rejects(client.history('forbidden'), (err) => {
    assert.equal(err.kind, 'forbidden');
    return true;
  });
});

test('a proxy answering with HTML never leaks its markup into the UI', async () => {
  await assert.rejects(tokenClient().history('proxied'), (err) => {
    assert.ok(!err.message.includes('<'), `markup leaked: ${err.message}`);
    assert.match(err.message, /proxy or gateway/);
    return true;
  });
});

test('a 200 that is not JSON is explained, not thrown as a parser crash', async () => {
  await assert.rejects(tokenClient().history('garbled'), (err) => {
    assert.equal(err.kind, 'parse');
    assert.match(err.message, /\/go/, 'the hint should mention the usual cause');
    return true;
  });
});

test('a dead host fails fast with something actionable', async () => {
  const dead = new GoCdClient({ serverUrl: 'http://127.0.0.1:1/go', authMode: 'session' });
  await assert.rejects(dead.version(), (err) => {
    assert.equal(err.kind, 'network');
    assert.match(err.message, /VPN|permission/);
    return true;
  });
});

test('session mode sends no Authorization header at all', async () => {
  seen = [];
  await new GoCdClient({ serverUrl: base, authMode: 'session' }).version();
  assert.equal(lastRequest('/go/api/version').headers.authorization, undefined);
});

test('basic mode sends a correctly encoded Authorization header', async () => {
  seen = [];
  const client = new GoCdClient({
    serverUrl: base,
    authMode: 'basic',
    username: 'karan',
    password: 'päss word',
  });
  await client.version();
  const header = lastRequest('/go/api/version').headers.authorization;
  assert.match(header, /^Basic /);
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'karan:päss word');
});

test('constructing a client without a server is refused up front', () => {
  assert.throws(() => new GoCdClient(null), GoCdError);
  assert.throws(() => new GoCdClient({}), GoCdError);
});

test('web UI links point at the pages GoCD actually serves', () => {
  const client = tokenClient();
  const parts = { pipeline: 'web-app', counter: 42, stage: 'build', stageCounter: '1', job: 'compile' };
  assert.equal(client.webUrl('pipeline', parts), `${base}/pipeline/activity/web-app`);
  assert.equal(client.webUrl('run', parts), `${base}/pipelines/value_stream_map/web-app/42`);
  assert.equal(client.webUrl('stage', parts), `${base}/pipelines/web-app/42/build/1`);
  assert.equal(client.webUrl('job', parts), `${base}/tab/build/detail/web-app/42/build/1/compile`);
});

test('path segments are percent-encoded so a name cannot escape its slot', () => {
  assert.equal(encodeSegment('web-app_build.1'), 'web-app_build.1');
  assert.equal(encodeSegment('a/b'), 'a%2Fb');
  assert.equal(encodeSegment('release/1.0'), 'release%2F1.0');
  assert.equal(encodeSegment('sp ace'), 'sp%20ace');
  assert.equal(encodeSegment('a?b#c'), 'a%3Fb%23c');
  assert.equal(encodeSegment('../../etc'), '..%2F..%2Fetc');
  assert.equal(encodeSegment('café'), 'caf%C3%A9', 'non-ASCII is encoded per UTF-8 byte');
});

test('the history cursor is read from the link, and nonsense is ignored', () => {
  assert.equal(nextPageCursor('http://go/api/pipelines/x/history?after=205'), 205);
  assert.equal(nextPageCursor('/history?page_size=10&after=42'), 42);
  assert.equal(nextPageCursor('/history?after=42&page_size=10'), 42);
  assert.equal(nextPageCursor('/history'), null);
  assert.equal(nextPageCursor('/history?before=9'), null);
  assert.equal(nextPageCursor('/history?after=notanumber'), null);
  assert.equal(nextPageCursor(undefined), null);
});

test('the host permission covers the whole origin, not just the /go path', () => {
  assert.equal(originPattern('https://gocd.example.com/go'), 'https://gocd.example.com/*');
  assert.equal(originPattern('http://localhost:8153/go/'), 'http://localhost:8153/*');
  assert.equal(originPattern('https://api.github.com'), 'https://api.github.com/*');
});

test('re-running selected jobs names them, so eleven passing jobs are left alone', async () => {
  // A stage of parallel e2e jobs is normal; re-running all of them to retry one
  // flaky job burns agent time for nothing.
  seen = [];
  await tokenClient().rerunSelectedJobs('web-app', 42, 'build', '1', ['zod', 'canvas']);

  const request = lastRequest('/go/api/stages/web-app/42/build/1/run-selected-jobs');
  assert.equal(request.headers.accept, 'application/vnd.go.cd.v3+json');
  assert.equal(request.headers['x-gocd-confirm'], 'true');
  assert.deepEqual(JSON.parse(request.body), { jobs: ['zod', 'canvas'] });
});

test('the three re-run shapes stay distinct endpoints', async () => {
  seen = [];
  const client = tokenClient();
  await client.rerunStage('web-app', 42, 'build', '1');
  await client.rerunFailedJobs('web-app', 42, 'build', '1');
  await client.rerunSelectedJobs('web-app', 42, 'build', '1', ['zod']);

  const paths = seen.filter((r) => r.method === 'POST').map((r) => r.url.split('/').pop());
  assert.deepEqual(paths, ['run', 'run-failed-jobs', 'run-selected-jobs']);
});
