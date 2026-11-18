#!/usr/bin/env node
// Reads a backtest's results (backtest/run.mjs): per change, per site and overall, weighted the way usage is priced.
// Plain Claude Code's figures are also read from its own logs when they are still on this computer, as a check of
// what the CLI reported.   node backtest/summarize.mjs <results.json>
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const file = process.argv[2];
const R = JSON.parse(readFileSync(file, "utf8"));
const W = { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 };
const weigh = (p) => Math.round(p.input * W.input + p.cacheWrite * W.cacheWrite + p.cacheRead * W.cacheRead + p.output * W.output);
const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};
const k = (n) => (n == null ? "–" : (n / 1000).toFixed(1) + "k");

const PROJECTS = join(homedir(), ".claude", "projects");
const stamp = basename(R.work); // design-map-backtest-<ts>
const folders = readdirSync(PROJECTS).filter((d) => d.includes(stamp));
function fromLogs(i, site) {
  const dir = folders.find((d) => d.endsWith(`${stamp}-${i}-${site}`));
  if (!dir) return null;
  const by = new Map();
  for (const f of readdirSync(join(PROJECTS, dir)).filter((f) => f.endsWith(".jsonl")))
    for (const line of readFileSync(join(PROJECTS, dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const u = e.message?.usage;
      if (e.type === "assistant" && u && e.message.id) by.set(e.message.id, u);
    }
  const s = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const u of by.values()) {
    s.input += u.input_tokens ?? 0;
    s.cacheWrite += u.cache_creation_input_tokens ?? 0;
    s.cacheRead += u.cache_read_input_tokens ?? 0;
    s.output += u.output_tokens ?? 0;
  }
  return { ...s, weighted: weigh(s), messages: by.size };
}

const rows = R.results.map((r, i) => {
  const logs = fromLogs(i, r.site);
  const a = r.a?.state === "done" ? r.a.weighted : null;
  const b = r.b?.state === "done" ? r.b.weighted : null;
  return { i, site: r.site, part: r.part, a, b, bLogs: logs?.weighted ?? null, ratio: a && b ? b / a : null, aSec: r.a?.seconds, bSec: r.b?.seconds, turns: r.b?.turns, aFiles: r.a?.files?.length ?? 0, bFiles: r.b?.filesChanged ?? 0, rules: r.a?.rulesSent ?? 0, aState: r.a?.state, bState: r.b?.state, aErr: r.a?.error, needs: r.a?.needs, bUsage: r.b?.usage, aUsage: r.a?.usage };
});
console.log("case                               studio   plain   (logs)   ratio   s A/B   turns  files A/B  rules");
for (const x of rows) console.log(`${(x.site + "/" + x.part).padEnd(34)} ${k(x.a).padStart(6)} ${k(x.b).padStart(7)} ${k(x.bLogs).padStart(8)} ${(x.ratio ? x.ratio.toFixed(1) + "×" : "–").padStart(7)} ${String(x.aSec).padStart(3)}/${String(x.bSec).padEnd(3)} ${String(x.turns ?? "–").padStart(5)}  ${x.aFiles}/${x.bFiles}       ${x.rules}  ${x.aState === "done" && x.bState === "done" ? "" : `[A ${x.aState} B ${x.bState}] ${x.aErr ?? ""}`}`);

const ok = rows.filter((x) => x.a && x.b);
const line = (label, xs) => {
  if (!xs.length) return;
  const ratios = xs.map((x) => x.ratio).sort((p, q) => p - q);
  console.log(`${label.padEnd(16)} n=${xs.length}  studio median ${k(median(xs.map((x) => x.a)))}  plain median ${k(median(xs.map((x) => x.b)))}  saved median ${k(median(xs.map((x) => x.b - x.a)))}  ratio of medians ${(median(xs.map((x) => x.b)) / median(xs.map((x) => x.a))).toFixed(1)}×  median ratio ${median(ratios.map((r) => Math.round(r * 100))) / 100}×  range ${ratios[0].toFixed(1)}–${ratios.at(-1).toFixed(1)}×  seconds A ${Math.min(...xs.map((x) => x.aSec))}–${Math.max(...xs.map((x) => x.aSec))} B ${Math.min(...xs.map((x) => x.bSec))}–${Math.max(...xs.map((x) => x.bSec))}  turns ${Math.min(...xs.map((x) => x.turns))}–${Math.max(...xs.map((x) => x.turns))}`);
};
console.log("");
line("all", ok);
for (const s of [...new Set(rows.map((x) => x.site))]) line(s, ok.filter((x) => x.site === s));
// The floor: cache reads counted as free on both sides
const noReads = (u) => (u ? Math.round(u.input * W.input + u.cacheWrite * W.cacheWrite + u.output * W.output) : null);
const withB = ok.filter((x) => x.bUsage);
console.log(`\nplain Claude Code, cache reads free: median ${k(median(withB.map((x) => noReads(x.bUsage))))}; raw median ${k(median(withB.map((x) => x.bUsage.input + x.bUsage.cacheWrite + x.bUsage.cacheRead + x.bUsage.output)))}`);
console.log(`studio usage fields recorded: ${JSON.stringify(rows.find((x) => x.aUsage)?.aUsage)}`);
console.log(`logs vs CLI report for plain Claude Code: ${rows.filter((x) => x.b && x.bLogs).map((x) => (x.bLogs / x.b).toFixed(2)).join(" ")}`);
console.log(`both done: ${ok.length} of ${rows.length}; studio made no file change: ${rows.filter((x) => x.aState === "done" && !x.aFiles).length}; plain made no file change: ${rows.filter((x) => x.bState === "done" && !x.bFiles).length}`);
