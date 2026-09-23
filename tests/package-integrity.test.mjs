/**
 * The promises in the README, enforced against the actual files.
 *
 * Each of these is a claim a user is being asked to trust -- no site access up
 * front, no content scripts, no remote code, nothing synced off the machine, no
 * innerHTML. A comment cannot keep those true; a failing test can.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (
      [
        ".git",
        ".github",
        ".githooks",
        "docs",
        "node_modules",
        "site",
        "tests",
        "tools",
      ].includes(entry)
    )
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SHIPPED = walk(ROOT);
const byExtension = (ext) => SHIPPED.filter((f) => extname(f) === ext);
const read = (file) => readFileSync(file, "utf8");
const name = (file) => relative(ROOT, file);

/**
 * Comments explain these rules, so scanning for a rule's own wording would trip
 * on the explanation. These checks read code; `//` inside a URL survives,
 * because it is never preceded by whitespace.
 */
const code = (file) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");

const manifest = JSON.parse(read(join(ROOT, "manifest.json")));

test("the manifest asks for no site access up front", () => {
  assert.deepEqual(
    manifest.host_permissions,
    [],
    "a fresh install must be able to reach nothing until the user names a server",
  );
  assert.ok(
    manifest.optional_host_permissions.length > 0,
    "access is requested at setup time instead, one origin at a time",
  );
});

test("the manifest asks for no permission it does not use", () => {
  // `offscreen` is the only way a Manifest V3 service worker can play a sound;
  // it has no DOM of its own.
  assert.deepEqual(manifest.permissions.slice().sort(), [
    "alarms",
    "notifications",
    "offscreen",
    "storage",
  ]);
  for (const dangerous of [
    "tabs",
    "webRequest",
    "cookies",
    "history",
    "bookmarks",
    "downloads",
    "scripting",
    "debugger",
  ]) {
    assert.ok(
      !manifest.permissions.includes(dangerous),
      `${dangerous} is not needed`,
    );
  }
});

test("there are no content scripts, so no web page can be read or touched", () => {
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(
    manifest.web_accessible_resources,
    undefined,
    "no page may reach into this extension either",
  );
});

test("the content security policy blocks remote and inline code", () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(
    csp,
    /script-src 'self'/,
    "no script from anywhere but this package",
  );
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.ok(
    !csp.includes("'unsafe-inline'"),
    "inline script would defeat the whole policy",
  );
  assert.ok(!csp.includes("'unsafe-eval'"));
});

test("the service worker is a module and every entry point it names exists", () => {
  assert.equal(manifest.background.type, "module");
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const path of referenced) {
    assert.ok(
      existsSync(join(ROOT, path)),
      `the manifest points at a missing file: ${path}`,
    );
  }
});

test("nothing anywhere writes to Chrome’s syncing storage", () => {
  // storage.sync uploads to Google and fans out to every signed-in machine.
  // A GoCD token must never travel that way.
  for (const file of SHIPPED.filter((f) =>
    [".js", ".html", ".json"].includes(extname(f)),
  )) {
    assert.ok(
      !/storage\.sync/.test(code(file)),
      `${name(file)} touches chrome.storage.sync`,
    );
  }
});

test("no source builds DOM from a string or evaluates one", () => {
  for (const file of byExtension(".js")) {
    const text = code(file);
    assert.ok(!/\.innerHTML\s*=/.test(text), `${name(file)} assigns innerHTML`);
    assert.ok(!/\.outerHTML\s*=/.test(text), `${name(file)} assigns outerHTML`);
    assert.ok(
      !/insertAdjacentHTML/.test(text),
      `${name(file)} uses insertAdjacentHTML`,
    );
    assert.ok(
      !/document\.write/.test(text),
      `${name(file)} uses document.write`,
    );
    assert.ok(!/\beval\s*\(/.test(text), `${name(file)} calls eval`);
    assert.ok(
      !/new\s+Function\s*\(/.test(text),
      `${name(file)} builds a Function from a string`,
    );
    assert.ok(
      !/setTimeout\s*\(\s*['"`]/.test(text),
      `${name(file)} passes a string to setTimeout`,
    );
  }
});

test("no page loads a script, style, font or image from the network", () => {
  for (const file of byExtension(".html")) {
    const text = read(file);
    assert.ok(
      !/(src|href)\s*=\s*["']https?:/i.test(text),
      `${name(file)} references a remote asset`,
    );
    assert.ok(
      !/<script(?![^>]*\ssrc=)/i.test(text),
      `${name(file)} contains an inline script`,
    );
    assert.ok(
      !/\son[a-z]+\s*=/i.test(text),
      `${name(file)} has an inline event handler attribute`,
    );
  }
  for (const file of byExtension(".css")) {
    const text = read(file);
    assert.ok(
      !/@import\s+url\(\s*["']?https?:/i.test(text),
      `${name(file)} imports a remote stylesheet`,
    );
    assert.ok(
      !/url\(\s*["']?https?:/i.test(text),
      `${name(file)} loads a remote resource`,
    );
  }
});

test("the only host referenced anywhere is the user\u2019s own server", () => {
  const allowedHosts = [/www\.w3\.org/, /localhost/, /127\.0\.0\.1/];
  for (const file of SHIPPED.filter((f) =>
    [".js", ".html"].includes(extname(f)),
  )) {
    const text = read(file);
    for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = match[1];
      const isExample =
        /(^|\.)example\.(com|org)$|^ghe\.example\.com$|^gocd\./.test(host);
      const isAllowed = allowedHosts.some((re) => re.test(host));
      assert.ok(
        isExample || isAllowed,
        `${name(file)} references ${host}; every network destination must be the user’s own server`,
      );
    }
  }
});

test("every icon a view asks for is actually drawn in the sprite", () => {
  const sprite = read(join(ROOT, "src/common/sprite.svg"));
  const drawn = new Set(
    [...sprite.matchAll(/id="i-([a-z-]+)"/g)].map((m) => m[1]),
  );

  const asked = new Set();
  for (const file of byExtension(".js")) {
    const text = read(file);
    for (const m of text.matchAll(/\bicon\(\s*['"]([a-z-]+)['"]/g))
      asked.add(m[1]);
    for (const m of text.matchAll(/\bicon:\s*['"]([a-z-]+)['"]/g))
      asked.add(m[1]);
  }

  // A scan that matches nothing passes without checking anything, which is
  // exactly what happened when the quote style changed under it.
  assert.ok(
    asked.size > 10,
    "the scan found no icons, so it is not testing one",
  );

  const missing = [...asked].filter((i) => !drawn.has(i));
  assert.deepEqual(missing, [], "these icons are used but never drawn");
});

test("every module import resolves to a file that exists", () => {
  let checked = 0;
  for (const file of byExtension(".js")) {
    const text = read(file);
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      checked += 1;
      const target = join(dirname(file), match[1]);
      assert.ok(
        existsSync(target),
        `${name(file)} imports ${match[1]}, which does not exist`,
      );
    }
  }
  assert.ok(
    checked > 5,
    "no relative imports were found, so nothing was checked",
  );
});

test("every asset a page links to ships in the package", () => {
  for (const file of byExtension(".html")) {
    const text = read(file);
    for (const match of text.matchAll(/(?:src|href)\s*=\s*"([^"#][^"]*)"/g)) {
      const target = join(dirname(file), match[1].split("?")[0]);
      assert.ok(
        existsSync(target),
        `${name(file)} links to ${match[1]}, which does not exist`,
      );
    }
  }
});

test("the hidden attribute actually hides, whatever else styles the element", () => {
  // Controls are toggled with `.hidden = true` while also carrying a class that
  // sets `display`, which beats the user-agent rule for [hidden].
  const base = read(join(ROOT, "src/common/base.css"));
  assert.match(base, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test("every dropdown default is actually one of that dropdown\u2019s options", () => {
  // A default with no matching <option> leaves the control blank or showing a
  // value nobody chose, and the next change event writes that back as if the
  // user had picked it.
  const html = read(join(ROOT, "src/setup/setup.html"));
  const store = read(join(ROOT, "src/lib/store.js"));

  const optionsFor = (id) => {
    const block = new RegExp(
      `<select id="${id}"[^>]*>([\\s\\S]*?)</select>`,
    ).exec(html);
    assert.ok(block, `no <select id="${id}"> in the settings page`);
    return [...block[1].matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
  };

  const defaultFor = (key) => {
    const match = new RegExp(
      `^\\s*${key}:\\s*['"]?([^,'"\n]+)['"]?,`,
      "m",
    ).exec(store);
    assert.ok(match, `no default for ${key} in store.js`);
    return match[1].trim();
  };

  for (const [id, key] of [
    ["poll", "pollSeconds"],
    ["background-minutes", "backgroundMinutes"],
    ["badge-source", "badgeSource"],
    ["theme", "theme"],
    ["density", "density"],
  ]) {
    const value = defaultFor(key);
    assert.ok(
      optionsFor(id).includes(value),
      `default ${key}=${value} is not an option of #${id} (${optionsFor(id).join(", ")})`,
    );
  }
});

test("every chime the player knows about actually ships", () => {
  // Two places have to agree: the files the generator writes, and the map the
  // offscreen page looks in. A mismatch is a chime that silently never plays.
  const player = read(join(ROOT, "src/offscreen/offscreen.js"));
  const referenced = [
    ...player.matchAll(/['"](sounds\/[a-z-]+\.wav)['"]/g),
  ].map((m) => m[1]);

  assert.deepEqual(referenced.sort(), [
    "sounds/failure.wav",
    "sounds/start.wav",
    "sounds/success.wav",
  ]);
  for (const file of referenced) {
    assert.ok(
      existsSync(join(ROOT, file)),
      `the player references a missing ${file}`,
    );
  }
});

test("the manifest version is a plain, well-formed version string", () => {
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
  assert.ok(
    manifest.description.length <= 132,
    "the Chrome Web Store truncates past 132 characters",
  );
});
