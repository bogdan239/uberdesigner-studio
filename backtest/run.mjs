#!/usr/bin/env node
// The backtest behind "tokens saved": the same everyday requests made two ways on our own test sites, with the token
// breakdown the Claude CLI reports kept for both (fresh input, cache writes, cache reads, output) and weighted the
// same way (savings.ts WEIGHT).
//   A. through the studio: the request on its layer (one part call), on the site's running dev server, sent as the
//      editor sends it: with the CSS rules the open page applies to the layer (a headless Chrome on the editor)
//   B. plain Claude Code, without uberdesigner: `claude -p "<request>"` in a fresh copy of the site, same model,
//      default tools and settings (skills off, so the skill can't step in). The copy is compared with the site
//      afterwards, to see that it changed something
// Each studio change is undone afterwards; each copy is thrown away. Nothing runs on a user's computer: we run this.
//
//   node backtest/run.mjs <cases.json> <out.json>      then: node backtest/summarize.mjs <out.json>
// cases.json: [{ "site": "dj-zak", "dir": "/abs/path", "port": 5215, "part": "hero-cta", "request": "…" }]
// The dev servers must be running with the studio installed. Needs Google Chrome (CHROME= for another path).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { openEditor, sleep } from "../tests/sites/cdp.mjs";

const [casesFile, outFile] = process.argv.slice(2);
if (!casesFile || !outFile) {
  console.error("usage: node backtest/run.mjs <cases.json> <out.json>");
  process.exit(1);
}
const CASES = JSON.parse(readFileSync(casesFile, "utf8"));
const MODEL = "claude-opus-5-5";
const EFFORT = "medium";
const CLAUDE = [process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude"].find((p) => p && existsSync(p)) ?? "claude";
const WORK = join(tmpdir(), `design-map-backtest-${Date.now()}`);
const PARALLEL_B = 3;
const WEIGHT = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const parts = (u) => ({ input: u?.input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, output: u?.output_tokens ?? 0 });
const weigh = (p) => Math.round(p.input * WEIGHT.input + p.cacheWrite * WEIGHT.cacheWrite + p.cacheRead * WEIGHT.cacheRead + p.output * WEIGHT.output);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function copySite(c, i) {
  const to = join(WORK, `${i}-${c.site}`);
  cpSync(c.dir, to, {
    recursive: true,
    filter: (src) => !/\/(node_modules|\.inspector|dist|\.git)(\/|$)/.test(src.slice(c.dir.length)) && !src.endsWith("inspector.map.json"),
  });
  if (existsSync(join(c.dir, "node_modules"))) symlinkSync(join(c.dir, "node_modules"), join(to, "node_modules"));
  return to;
}

const headersFor = (c) => ({ "Content-Type": "application/json", "X-Inspector-Token": readFileSync(join(c.dir, ".inspector", "token"), "utf8").trim() });

async function viaStudio(c, tab) {
  const base = `http://localhost:${c.port}/__inspector`;
  const headers = headersFor(c);
  const map = JSON.parse(readFileSync(join(c.dir, "inspector.map.json"), "utf8"));
  const part = map.parts.find((p) => p.id === c.part);
  if (!part) throw new Error(`${c.site}: no part ${c.part}`);
  const prompt = [...part.prompt.map((r) => `${r.where}: ${r.text}`), ...(part.note ? [part.note] : [])].join("\n");
  const page = (await tab.ev(`window.__inspectorPageFacts(${JSON.stringify(part.id)}) ?? null`)) ?? undefined;
  const started = Date.now();
  const res = await (await fetch(`${base}/run`, { method: "POST", headers, body: JSON.stringify({ mode: "part", part: part.label, partId: part.id, prompt, request: c.request, page, model: MODEL, effort: EFFORT }) })).json();
  if (!res.ok) throw new Error(`${c.site}/${c.part}: ${res.error}`);
  let j;
  for (let n = 0; n < 150; n++) {
    await sleep(2000);
    j = (await (await fetch(`${base}/jobs`)).json()).jobs.find((x) => x.id === res.job.id);
    if (j && (j.state === "done" || j.state === "error")) break;
  }
  const out = { state: j?.state ?? "timeout", error: j?.error ?? null, usage: j?.usage ?? null, weighted: j?.usage?.weighted ?? null, seconds: Math.round((Date.now() - started) / 1000), rulesSent: page?.rules?.length ?? 0, files: j?.files ?? [], needs: j?.needs ?? null, summary: j?.summary ?? "" };
  if (j) {
    await fetch(`${base}/undo`, { method: "POST", headers, body: JSON.stringify({ thread: j.thread }) });
    await fetch(`${base}/dismiss`, { method: "POST", headers, body: JSON.stringify({ id: j.id }) });
  }
  return out;
}

function viaClaudeCode(c, dir) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = ["-p", `In the website in this folder: ${c.request}`, "--output-format", "json", "--model", MODEL, "--permission-mode", "acceptEdits", "--disallowedTools", "Skill"];
    const child = spawn(CLAUDE, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      let r = null;
      try {
        r = JSON.parse(out.slice(out.indexOf("{")));
      } catch {
        /* reported below */
      }
      // what it changed, against the site it was copied from
      const diff = spawnSync("diff", ["-rq", "-x", "node_modules", "-x", ".inspector", "-x", "dist", "-x", ".git", "-x", "inspector.map.json", "-x", ".claude", c.dir, dir], { encoding: "utf8" });
      const changed = diff.stdout.split("\n").filter(Boolean).map((l) => l.replace(c.dir, "").replace(dir, "").slice(0, 120));
      const usage = r ? parts(r.usage) : null;
      resolve(
        r
          ? { state: r.is_error ? "error" : "done", error: r.is_error ? String(r.result ?? "").slice(0, 300) : null, usage, weighted: weigh(usage), raw: usage.input + usage.cacheWrite + usage.cacheRead + usage.output, turns: r.num_turns ?? null, seconds: Math.round((Date.now() - started) / 1000), filesChanged: changed.length, changed, folder: dir, summary: String(r.result ?? "").slice(0, 400) }
          : { state: "error", error: (err || out).slice(0, 300), usage: null, weighted: null, turns: null, seconds: Math.round((Date.now() - started) / 1000), filesChanged: changed.length, folder: dir, summary: "" },
      );
    });
  });
}

mkdirSync(WORK, { recursive: true });
const copies = CASES.map((c, i) => copySite(c, i));
log(`${CASES.length} cases; copies in ${WORK}`);
const results = CASES.map((c) => ({ ...c, dir: undefined, a: null, b: null }));
const save = () => writeFileSync(outFile, JSON.stringify({ work: WORK, started: startedAt, model: MODEL, effort: EFFORT, results }, null, 2) + "\n");
const startedAt = new Date().toISOString();

const bySite = new Map();
CASES.forEach((c, i) => bySite.set(c.site, [...(bySite.get(c.site) ?? []), i]));
const tabs = [];
const runA = Promise.all(
  [...bySite.values()].map(async (idx) => {
    const tab = await openEditor(`http://localhost:${CASES[idx[0]].port}/__inspector/editor`);
    tabs.push(tab);
    await tab.sleep(9000); // the site's intro, and its stylesheets
    for (const i of idx) {
      try {
        results[i].a = await viaStudio(CASES[i], tab);
      } catch (e) {
        results[i].a = { state: "error", error: String(e), weighted: null };
      }
      log(`A ${CASES[i].site}/${CASES[i].part}: weighted ${results[i].a.weighted}, ${results[i].a.seconds} s, ${results[i].a.rulesSent} rules (${results[i].a.state})`);
      save();
    }
  }),
);
const queue = CASES.map((_, i) => i);
const runB = Promise.all(
  Array.from({ length: PARALLEL_B }, async () => {
    for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
      results[i].b = await viaClaudeCode(CASES[i], copies[i]);
      log(`B ${CASES[i].site}/${CASES[i].part}: weighted ${results[i].b.weighted}, ${results[i].b.turns} turns, ${results[i].b.seconds} s, ${results[i].b.filesChanged} files changed (${results[i].b.state})`);
      save();
    }
  }),
);
await Promise.all([runA, runB]);
for (const t of tabs) t.close();
rmSync(WORK, { recursive: true, force: true });
save();
log("finished", new Date().toISOString());
process.exit(0);
