#!/usr/bin/env node
// 反証条件ウォッチ｜「やめる数字」と判定期限を登録し、期限が来たら知らせる
//
// なぜこれを作るのか：
//   12本のシミュレーションで、反証条件を数字で先に決めた案（I・J・L）は成功し、
//   決めなかった案（K）だけが失敗した。Kでは vc-review が2027年に
//   「何%を下回ったら何をやめるのか、今書け」と要求し、ceo-cpo が保留した。
//   その要求を飲む実行コストは、その日の会議10分だった。
//
//   このツールがやるのは2つだけ。
//     ① 判定期限が来たことを、忘れる前に知らせる（学び2：判定期限を日付で切る）
//     ② 条件を後から緩めたことを、見えるようにする（学び7：撤退条件は開始日に決める）
//
//   ②が本体である。条件は「破られること」より「静かに書き換えられること」で死ぬ。
//   このツールは条件文の変更を禁止しない。変更を必ず記録に残すだけ。
//
// 依存パッケージなし（Node 18+ 標準機能のみ）。CI/cron に置ける（未判定があれば exit 1）。
//
//   node conditions.mjs check --today=2027-12-31
//   node conditions.mjs judge R-3 --result=cleared --value=31.2% --note="転換率31.2%"
//   node conditions.mjs amend R-5 --to="..." --reason="..." --who=代表3
//   node conditions.mjs history
//   node conditions.mjs list

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CONDITIONS_DATA_DIR ?? ROOT;
const DEF = join(DATA_DIR, "conditions.json");
const LOG = join(DATA_DIR, "judgments.jsonl");

const RESULTS = new Set(["cleared", "triggered", "undecidable"]);
const RESULT_JA = { cleared: "クリア", triggered: "発動", undecidable: "判定不能" };

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function die(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}
function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function today() {
  return arg("today", new Date().toISOString().slice(0, 10));
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

function loadDefs() {
  if (!existsSync(DEF)) die(`${DEF} がありません。conditions.sample.json をコピーして作ってください`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(DEF, "utf8"));
  } catch (e) {
    die(`conditions.json が壊れています: ${e.message}`);
  }
  if (!Array.isArray(raw)) die("conditions.json は配列である必要があります");
  for (const c of raw) {
    if (!c.id) die("id のない条件があります");
    if (!c.condition) die(`${c.id}: condition（条件文）が必要です`);
    if (!c.onTrigger) die(`${c.id}: onTrigger（発動したらやること）が必要です`);
    if (!c.owner) die(`${c.id}: owner（担当）が必要です`);
    const hasDates = Array.isArray(c.judgeOn) && c.judgeOn.length > 0;
    if (!hasDates && c.every !== "month") die(`${c.id}: judgeOn（判定日の配列）か "every":"month" が必要です`);
    for (const d of c.judgeOn ?? []) if (!isDate(d)) die(`${c.id}: 判定日 "${d}" が YYYY-MM-DD ではありません`);
  }
  return raw;
}
function loadLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
function append(ev) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(LOG, `${JSON.stringify({ ...ev, at: new Date().toISOString() })}\n`);
}

/** その条件の、基準日までに到来している判定日のうち、まだ判定されていないものを返す */
function outstanding(cond, log, t) {
  const judged = new Set(log.filter((e) => e.t === "judgment" && e.id === cond.id).map((e) => e.judgeOn));
  let dates = cond.judgeOn ?? [];
  if (cond.every === "month") {
    // 毎月末を判定日として扱う（R-5 のような常時監視の条件）
    dates = [];
    const start = cond.from ?? t.slice(0, 4) + "-01-01";
    let d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
    const end = new Date(`${t}T00:00:00Z`);
    while (d <= end) {
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      if (last <= t) dates.push(last);
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  return dates.filter((d) => d <= t && !judged.has(d)).sort();
}

// ---------------------------------------------------------------- commands

function cmdCheck() {
  const t = today();
  if (!isDate(t)) die("--today=YYYY-MM-DD の形式で指定してください");
  const defs = loadDefs();
  const log = loadLog();

  const rows = [];
  for (const c of defs) {
    if (c.retired) continue;
    for (const d of outstanding(c, log, t)) rows.push({ c, d, late: daysBetween(d, t) });
  }

  console.log(`基準日: ${t}`);
  if (rows.length === 0) {
    console.log("\n未判定の反証条件はありません。");
    // 次に来る判定日を出す（忘れさせないため）
    const upcoming = [];
    for (const c of defs) {
      if (c.retired) continue;
      for (const d of c.judgeOn ?? []) if (d > t) upcoming.push({ id: c.id, d });
    }
    upcoming.sort((a, b) => a.d.localeCompare(b.d));
    if (upcoming.length) {
      console.log("\n次に来る判定日:");
      for (const u of upcoming.slice(0, 5)) console.log(`  ${u.d}  ${u.id}（あと${daysBetween(t, u.d)}日）`);
    }
    process.exit(0);
  }

  console.log(`\n判定期限が来ている反証条件が ${rows.length} 件あります。\n`);
  rows.sort((a, b) => a.d.localeCompare(b.d));
  for (const { c, d, late } of rows) {
    console.log(`── ${c.id}  判定日 ${d}${late > 0 ? `（${late}日超過）` : "（本日）"}`);
    console.log(`   条件      : ${c.condition}`);
    console.log(`   発動したら: ${c.onTrigger}`);
    console.log(`   担当      : ${c.owner}`);
    if (c.amendedFrom) console.log(`   ⚠ この条件は過去に変更されています。history で経緯を確認してください`);
    console.log(`   記録      : node conditions.mjs judge ${c.id} --result=cleared|triggered --value=... --note=...`);
    console.log("");
  }
  console.log("判定していない条件は、条件ではありません。");
  process.exit(1); // CI/cron で拾えるように
}

function cmdJudge() {
  const id = process.argv[3];
  if (!id || id.startsWith("--")) die("使い方: conditions.mjs judge <ID> --result=cleared|triggered [--value=] [--note=]");
  const result = arg("result");
  if (!RESULTS.has(result)) die(`--result は ${[...RESULTS].join(" / ")} のいずれかです`);
  const defs = loadDefs();
  const c = defs.find((x) => x.id === id);
  if (!c) die(`条件 ${id} が見つかりません`);

  const log = loadLog();
  const t = today();
  const pending = outstanding(c, log, t);
  const judgeOn = arg("on", pending[0]);
  if (!judgeOn) die(`${id}: 基準日 ${t} 時点で未判定の判定日がありません（--on=YYYY-MM-DD で明示できます）`);

  append({
    t: "judgment",
    id,
    judgeOn,
    result,
    value: arg("value"),
    note: arg("note"),
    conditionAtJudgment: c.condition, // 判定時点の条件文を凍結して残す
  });
  console.log(`${id}（判定日 ${judgeOn}）を「${RESULT_JA[result]}」として記録しました。`);
  if (result === "triggered") {
    console.log("\n発動しました。次にやること:");
    console.log(`  ${c.onTrigger}`);
    console.log(`  担当: ${c.owner}`);
    console.log("\n※ 発動したのに何も止めなければ、この条件は次から機能しません。");
  }
}

function cmdAmend() {
  const id = process.argv[3];
  const to = arg("to");
  const reason = arg("reason");
  const who = arg("who");
  if (!id || id.startsWith("--")) die("使い方: conditions.mjs amend <ID> --to=新しい条件文 --reason=理由 --who=誰が");
  if (!to) die("--to（新しい条件文）が必要です");
  if (!reason) die("--reason（変更の理由）が必要です。理由なしの変更は受け付けません");
  if (!who) die("--who（誰が決めたか）が必要です");

  const defs = loadDefs();
  const c = defs.find((x) => x.id === id);
  if (!c) die(`条件 ${id} が見つかりません`);

  const before = c.condition;
  append({ t: "amendment", id, on: today(), from: before, to, reason, who });
  c.amendedFrom = [...(c.amendedFrom ?? []), { from: before, on: today(), reason, who }];
  c.condition = to;
  writeFileSync(DEF, `${JSON.stringify(defs, null, 2)}\n`);

  console.log(`${id} の条件文を変更しました。`);
  console.log(`  変更前: ${before}`);
  console.log(`  変更後: ${to}`);
  console.log(`  理由  : ${reason}（${who}）`);
  console.log("");
  console.log("⚠ 変更は記録に残りました。history と check に必ず表示されます。");
  console.log("  条件を緩めたのか、観測対象を是正したのかは、あとから読む人が判断します。");
  console.log("  緩和なら、そう書いてください。");
}

function cmdHistory() {
  const log = loadLog();
  if (log.length === 0) return console.log("記録はまだありません。");

  const judgments = log.filter((e) => e.t === "judgment");
  const amendments = log.filter((e) => e.t === "amendment");

  console.log("# 反証条件の履歴\n");
  console.log("## 判定\n");
  if (judgments.length === 0) {
    console.log("なし。\n");
  } else {
    console.log("| 判定日 | ID | 結果 | 値 | 備考 |");
    console.log("|---|---|---|---|---|");
    for (const e of judgments.sort((a, b) => a.judgeOn.localeCompare(b.judgeOn))) {
      console.log(`| ${e.judgeOn} | ${e.id} | **${RESULT_JA[e.result]}** | ${e.value ?? "—"} | ${e.note ?? ""} |`);
    }
    const trig = judgments.filter((e) => e.result === "triggered").length;
    console.log("");
    console.log(`判定 **${judgments.length}回**、うち発動 **${trig}回**。`);
    if (judgments.length >= 8 && trig === 0) {
      console.log("");
      console.log("> ⚠ 一度も発動していません。**それは良い経営の証拠かもしれないし、条件が緩い証拠かもしれません。**");
      console.log("> 反証条件の目的は撤退させることではなく、「間違っているかもしれない」と定期的に思い出すことです。");
      console.log("> 一度も殴られない条件は、その機能を果たしていません。引き直しを検討してください。");
    }
  }

  console.log("\n## 条件文の変更\n");
  if (amendments.length === 0) {
    console.log("なし。**開始日に決めた条件が、一度も書き換えられていません。**");
  } else {
    for (const e of amendments) {
      console.log(`### ${e.id}（${e.on ?? e.at.slice(0, 10)}・${e.who}）`);
      console.log(`- 変更前: ${e.from}`);
      console.log(`- 変更後: ${e.to}`);
      console.log(`- 理由  : ${e.reason}`);
      console.log("");
    }
  }
}

function cmdList() {
  const defs = loadDefs();
  const log = loadLog();
  const t = today();
  console.log("| ID | 条件 | 次の判定日 | 担当 | 状態 |");
  console.log("|---|---|---|---|---|");
  for (const c of defs) {
    const next = (c.judgeOn ?? []).filter((d) => d > t).sort()[0] ?? (c.every === "month" ? "毎月末" : "—");
    const out = outstanding(c, log, t).length;
    const state = c.retired ? "終了" : out > 0 ? `**未判定${out}件**` : "監視中";
    console.log(`| ${c.id} | ${c.condition} | ${next} | ${c.owner} | ${state} |`);
  }
}

const HELP = `反証条件ウォッチ｜「やめる数字」と判定期限の管理

  check     判定期限が来ている条件を出す（未判定があれば exit 1）  [--today=YYYY-MM-DD]
  judge     判定結果を記録する    <ID> --result=cleared|triggered|undecidable [--value=] [--note=] [--on=]
  amend     条件文を変更する（理由必須・記録に残る） <ID> --to= --reason= --who=
  history   判定と変更の履歴を出す
  list      登録されている条件を一覧する

定義: ${DEF}
記録: ${LOG}（追記のみ）

このツールは条件の変更を禁止しません。変更を見えるようにするだけです。`;

const cmd = process.argv[2];
const table = { check: cmdCheck, judge: cmdJudge, amend: cmdAmend, history: cmdHistory, list: cmdList };
if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(0);
}
if (!table[cmd]) die(`不明なコマンド: ${cmd}\n\n${HELP}`);
table[cmd]();
