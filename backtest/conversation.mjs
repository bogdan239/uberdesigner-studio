#!/usr/bin/env node
// The context-window test: a site's requests asked of plain Claude Code one after another in ONE conversation, as a
// person working in a chat would, in a fresh copy of the site (no studio, no map), same model, default tools and
// settings, skills off. For each change it keeps the token breakdown the Claude CLI reports and, from Claude Code's own
// log of the conversation, how many tokens the conversation held when the change began and when it ended.
//
//   node backtest/conversation.mjs <cases.json> <out.json>
// cases.json: the same file backtest/run.mjs takes; a site's cases are asked in the order they are listed.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [casesFile, outFile] = process.argv.slice(2);
if (!casesFile || !outFile) {
  console.error("usage: node backtest/conversation.mjs <cases.json> <out.json>");
  process.exit(1);
}
const CASES = JSON.parse(readFileSync(casesFile, "utf8"));
const MODEL = "claude-opus-5-5";
const CLAUDE = [process.env.CLAUDE_BIN, join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude"].find((p) => p && existsSync(p)) ?? "claude";
const WORK = join(realpathSync(tmpdir()), `design-map-conversation-${Date.now()}`);
const WEIGHT = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const parts = (u) => ({ input: u?.input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, output: u?.output_tokens ?? 0 });
const weigh = (p) => Math.round(p.input * WEIGHT.input + p.cacheWrite * WEIGHT.cacheWrite + p.cacheRead * WEIGHT.cacheRead + p.output * WEIGHT.output);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function ask(dir, text, session) {
  return new Promise((resolve) => {
    const started = new Date();
    const args = ["-p", text, "--output-format", "json", "--model", MODEL, "--permission-mode", "acceptEdits", "--disallowedTools", "Skill", ...(session ? ["--resume", session] : [])];
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
      const usage = r ? parts(r.usage) : null;
      resolve({ from: started.toISOString(), to: new Date().toISOString(), state: r && !r.is_error ? "done" : "error", error: r ? (r.is_error ? String(r.result ?? "").slice(0, 300) : null) : (err || out).slice(0, 300), session: r?.session_id ?? null, usage, weighted: usage ? weigh(usage) : null, turns: r?.num_turns ?? null, seconds: Math.round((Date.now() - started) / 1000), summary: String(r?.result ?? "").slice(0, 300) });
    });
  });
}

// Every request to the model in the conversation's logs, once each, in order: what the conversation held when it was
// sent (input, cache reads and cache writes together) and what came back
function requests(dir) {
  const folder = join(homedir(), ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  const by = new Map();
  if (!existsSync(folder)) return [];
  for (const f of readdirSync(folder).filter((f) => f.endsWith(".jsonl")))
    for (const line of readFileSync(join(folder, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const u = e.message?.usage;
      if (e.type === "assistant" && u && e.message.id && e.timestamp) by.set(e.message.id, { at: e.timestamp, held: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens ?? 0 });
    }
  return [...by.values()].sort((a, b) => (a.at < b.at ? -1 : 1));
}

mkdirSync(WORK, { recursive: true });
const bySite = new Map();
for (const c of CASES) bySite.set(c.site, [...(bySite.get(c.site) ?? []), c]);
const startedAt = new Date().toISOString();
const conversations = await Promise.all(
  [...bySite.entries()].map(async ([site, cases]) => {
    const from = cases[0].dir;
    const dir = join(WORK, site);
    cpSync(from, dir, { recursive: true, filter: (src) => !/\/(node_modules|\.inspector|dist|\.git)(\/|$)/.test(src.slice(from.length)) && !src.endsWith("inspector.map.json") });
    if (existsSync(join(from, "node_modules"))) symlinkSync(join(from, "node_modules"), join(dir, "node_modules"));
    const changes = [];
    let session = null;
    for (const [n, c] of cases.entries()) {
      // The first message says where the site is, as in the single-change test; later ones are just the request
      const r = await ask(dir, n === 0 ? `In the website in this folder: ${c.request}` : c.request, session);
      session = r.session ?? session;
      const diff = spawnSync("diff", ["-rq", "-x", "node_modules", "-x", ".inspector", "-x", "dist", "-x", ".git", "-x", "inspector.map.json", "-x", ".claude", from, dir], { encoding: "utf8" });
      changes.push({ n: n + 1, part: c.part, request: c.request, ...r, filesDifferentFromSite: diff.stdout.split("\n").filter(Boolean).length });
      log(`${site} change ${n + 1}: weighted ${r.weighted}, ${r.turns} turns, ${r.seconds} s (${r.state})`);
    }
    const reqs = requests(dir);
    for (const ch of changes) {
      const mine = reqs.filter((q) => q.at >= ch.from && q.at <= ch.to);
      ch.requests = mine.length;
      ch.heldAtStart = mine[0]?.held ?? null;
      ch.heldAtEnd = mine.length ? mine.at(-1).held + mine.at(-1).out : null;
    }
    return { site, changes };
  }),
);
rmSync(WORK, { recursive: true, force: true });
writeFileSync(outFile, JSON.stringify({ started: startedAt, model: MODEL, conversations }, null, 2) + "\n");
for (const c of conversations) log(c.site, "held after each change:", c.changes.map((x) => x.heldAtEnd).join(" → "), "| weighted per change:", c.changes.map((x) => x.weighted).join(", "));
process.exit(0);
