#!/usr/bin/env node
// フォロー台帳｜7日後フォローと6ヶ月後フォロー（＝逆方向の数字）の配信管理と集計
//
// なぜこれが最初のツールなのか：
//   本命シナリオで会社を救ったのは、プロダクトではなく「測っていたこと」だった。
//   2029年に外部メディアの見出しを差し替えさせた反証材料は、6ヶ月後フォローの
//   最後の1問（「いま治療はどうされていますか」）の2年分の集計だった。
//   保険は事故の後には買えない。だから有償1件目から回す。
//
// 設計上の制約（honmei/ の決定に対応）：
//   - 回答率を必ず併記する。率だけを出さない（学び5・年次レポートの様式）
//   - 実数で出す。満足度低評価などは率に丸めない
//   - 個人情報を持たない。contactRef は予約/決済システム側のキーであり、
//     氏名・メールアドレスはこの台帳に書かない（同意文書 5項・legal-impact の要求）
//   - 相談件数に目標値を置かない（失敗パターン9）。report は目標欄を持たない
//   - 追記のみ。過去の記録を書き換えない（events.jsonl は append-only）
//
// 依存パッケージなし（Node 18+ 標準機能のみ）。
//
//   node followup.mjs add --date=2026-09-08 --kind=45min --supporter=A --contact=tx_8f21
//   node followup.mjs due --today=2026-09-15
//   node followup.mjs record --id=S-0001 --step=yes --undecided=no --told=yes --good=yes
//   node followup.mjs record6m --id=S-0001 --status=continuing
//   node followup.mjs skip --id=S-0001 --which=7d --reason=本人希望
//   node followup.mjs report --from=2026-09-01 --to=2026-10-31
//   node followup.mjs report --from=2027-01-01 --to=2027-12-31 --annual

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FOLLOWUP_DATA_DIR ?? join(ROOT, "data");
const EVENTS = join(DATA_DIR, "events.jsonl");

const KINDS = new Set(["15min", "45min", "90min", "member"]);
const STATUSES = new Set(["continuing", "paused", "ended", "undecided"]);
const STATUS_JA = {
  continuing: "続けている",
  paused: "休んでいる",
  ended: "終えた",
  undecided: "まだ決めていない",
};

// ---------------------------------------------------------------- utilities

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function has(flag) {
  return process.argv.includes(`--${flag}`);
}
function die(msg) {
  console.error(`エラー: ${msg}`);
  process.exit(1);
}
function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}
function today() {
  return arg("today", new Date().toISOString().slice(0, 10));
}
function pct(n, d) {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}

function readEvents() {
  if (!existsSync(EVENTS)) return [];
  return readFileSync(EVENTS, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        die(`events.jsonl の ${i + 1} 行目が壊れています`);
      }
    });
}
function append(ev) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(EVENTS, `${JSON.stringify({ ...ev, at: new Date().toISOString() })}\n`);
}

/** セッションごとの現在の状態に畳む（events は追記のみなので、後勝ちで反映する） */
function fold(events) {
  const sessions = new Map();
  for (const e of events) {
    if (e.t === "session") {
      sessions.set(e.id, {
        id: e.id,
        date: e.date,
        kind: e.kind,
        supporter: e.supporter,
        contact: e.contact,
        f7: null,
        f6m: null,
        skip7: null,
        skip6m: null,
      });
      continue;
    }
    const s = sessions.get(e.id);
    if (!s) continue;
    if (e.t === "followup7") s.f7 = e;
    if (e.t === "followup6m") s.f6m = e;
    if (e.t === "skip" && e.which === "7d") s.skip7 = e;
    if (e.t === "skip" && e.which === "6m") s.skip6m = e;
  }
  return [...sessions.values()];
}

function nextId(sessions) {
  const max = sessions.reduce((m, s) => Math.max(m, Number(s.id.replace(/\D/g, "")) || 0), 0);
  return `S-${String(max + 1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- commands

function cmdAdd() {
  const date = arg("date");
  const kind = arg("kind");
  const supporter = arg("supporter");
  const contact = arg("contact");
  if (!isDate(date)) die("--date=YYYY-MM-DD が必要です");
  if (!KINDS.has(kind)) die(`--kind は ${[...KINDS].join(" / ")} のいずれかです`);
  if (!supporter) die("--supporter が必要です（記号でよい。実名は入れない）");
  if (!contact) die("--contact が必要です（予約/決済システム側のキー。メールアドレスや氏名は入れない）");
  if (/@/.test(contact)) die("--contact にメールアドレスを入れないでください。外部システムのキーを渡してください");

  const sessions = fold(readEvents());
  const id = nextId(sessions);
  append({ t: "session", id, date, kind, supporter, contact });

  const prior = sessions.filter((s) => s.contact === contact).length;
  console.log(`登録しました: ${id}（${date} / ${kind} / 担当${supporter}）`);
  console.log(`  7日後フォロー送信予定 : ${addDays(date, 7)}`);
  console.log(`  6ヶ月後フォロー送信予定: ${addMonths(date, 6)}`);
  if (prior > 0) console.log(`  ※ この方は${prior + 1}回目の利用です（「2回目も払った」に計上されます）`);
}

function cmdDue() {
  const t = today();
  if (!isDate(t)) die("--today=YYYY-MM-DD の形式で指定してください");
  const sessions = fold(readEvents());

  const due7 = sessions.filter((s) => !s.f7 && !s.skip7 && addDays(s.date, 7) <= t);
  const due6 = sessions.filter((s) => !s.f6m && !s.skip6m && addMonths(s.date, 6) <= t);

  const show = (list, label, dueOf) => {
    console.log(`\n【${label}】${list.length}件`);
    if (list.length === 0) return console.log("  なし");
    for (const s of list.sort((a, b) => dueOf(a).localeCompare(dueOf(b)))) {
      const d = dueOf(s);
      const late = d < t ? `  ※${Math.round((Date.parse(t) - Date.parse(d)) / 86400000)}日超過` : "";
      console.log(`  ${s.id}  送信予定 ${d}  宛先キー ${s.contact}  (${s.date} ${s.kind} 担当${s.supporter})${late}`);
    }
  };
  console.log(`基準日: ${t}`);
  show(due7, "7日後フォロー 未送信/未回答", (s) => addDays(s.date, 7));
  show(due6, "6ヶ月後フォロー 未送信/未回答（＝逆方向の数字）", (s) => addMonths(s.date, 6));
  console.log("\n※ 宛先キーは予約/決済システム側で引いてください。この台帳は連絡先を持ちません。");
}

function cmdRecord() {
  const id = arg("id");
  if (!id) die("--id が必要です");
  const yn = (v, name) => {
    if (v === undefined) return undefined;
    if (!["yes", "no", "other"].includes(v)) die(`--${name} は yes / no / other のいずれかです`);
    return v;
  };
  const ev = {
    t: "followup7",
    id,
    answeredAt: arg("answered", today()),
    step: yn(arg("step"), "step"),          // 次の一歩を実行したか
    undecided: yn(arg("undecided"), "undecided"), // 「今は決めない」と自分で決めたか
    told: yn(arg("told"), "told"),          // 医師や家族に話せたか
    good: yn(arg("good"), "good"),          // 自由記述が肯定的だったか（失敗パターン3の3列用）
    lowSat: has("low-sat") || undefined,    // 満足度が低かった（年次レポートは実数で出す）
    lowSatReason: arg("low-sat-reason"),
  };
  if (ev.step === undefined) die("--step=yes|no|other は必須です（Gate②の主指標）");
  append(ev);
  console.log(`${id}: 7日後フォローを記録しました`);
}

function cmdRecord6m() {
  const id = arg("id");
  const status = arg("status");
  if (!id) die("--id が必要です");
  if (!STATUSES.has(status)) die(`--status は ${[...STATUSES].join(" / ")} のいずれかです`);
  append({ t: "followup6m", id, answeredAt: arg("answered", today()), status });
  console.log(`${id}: 6ヶ月後フォロー（${STATUS_JA[status]}）を記録しました`);
}

function cmdSkip() {
  const id = arg("id");
  const which = arg("which");
  const reason = arg("reason");
  if (!id) die("--id が必要です");
  if (!["7d", "6m"].includes(which)) die("--which=7d または --which=6m");
  if (!reason) die("--reason が必要です（送らなかった理由は必ず残す）");
  append({ t: "skip", id, which, reason });
  console.log(`${id}: ${which} を送信対象から外しました（理由: ${reason}）`);
}

function cmdReport() {
  const from = arg("from");
  const to = arg("to");
  if (!isDate(from) || !isDate(to)) die("--from=YYYY-MM-DD --to=YYYY-MM-DD が必要です");
  const all = fold(readEvents());
  const s = all.filter((x) => x.date >= from && x.date <= to);
  if (s.length === 0) die("対象期間にセッションがありません");

  // --- Gate② -------------------------------------------------------------
  // 分母は「送信予定日が到来したもの」だけ。まだ来ていないフォローを未回答に数えない。
  const asOf = arg("as-of", today());
  const sent7 = s.filter((x) => !x.skip7 && addDays(x.date, 7) <= asOf);
  const ans7 = sent7.filter((x) => x.f7);
  const step = ans7.filter((x) => x.f7.step === "yes").length;
  const undec = ans7.filter((x) => x.f7.undecided === "yes").length;
  const told = ans7.filter((x) => x.f7.told === "yes").length;

  // --- 逆方向の数字 --------------------------------------------------------
  const sent6 = s.filter((x) => !x.skip6m && addMonths(x.date, 6) <= asOf);
  const ans6 = sent6.filter((x) => x.f6m);
  const counts = Object.fromEntries([...STATUSES].map((k) => [k, ans6.filter((x) => x.f6m.status === k).length]));

  // --- 失敗パターン3の3列 ---------------------------------------------------
  const good = ans7.filter((x) => x.f7.good === "yes").length;
  const paid = s.length;
  const contactsInPeriod = new Set(s.map((x) => x.contact));
  let repeat = 0;
  for (const c of contactsInPeriod) {
    const firstEver = all.filter((x) => x.contact === c).sort((a, b) => a.date.localeCompare(b.date))[0];
    const inPeriod = s.filter((x) => x.contact === c);
    // 期間内のセッションのうち、その人の通算1件目でないもの＝「2回目も払った」
    repeat += inPeriod.filter((x) => x.id !== firstEver.id).length;
  }

  // --- 満足度が低かったセッション（実数で出す） -------------------------------
  const low = ans7.filter((x) => x.f7.lowSat);
  const lowByReason = {};
  for (const x of low) {
    const k = x.f7.lowSatReason ?? "（理由の記載なし）";
    lowByReason[k] = (lowByReason[k] ?? 0) + 1;
  }

  const L = [];
  L.push(`# フォロー台帳 集計｜${from} 〜 ${to}`);
  L.push("");
  L.push(`基準日 **${asOf}**（この日までに送信予定日が到来したフォローのみを分母に数える）`);
  L.push("");
  L.push(`対象セッション **${s.length}件**（15分 ${s.filter((x) => x.kind === "15min").length} / 45分 ${s.filter((x) => x.kind === "45min").length} / 90分 ${s.filter((x) => x.kind === "90min").length} / 会員 ${s.filter((x) => x.kind === "member").length}）`);
  L.push("");
  L.push("## 1. 顧客成果（Gate②）");
  L.push("");
  L.push("| 項目 | 実数 | 割合 |");
  L.push("|---|---|---|");
  L.push(`| 7日後フォロー 送信 | ${sent7.length}件 | — |`);
  L.push(`| 　うち回答 | ${ans7.length}件 | **回答率 ${pct(ans7.length, sent7.length)}** |`);
  L.push(`| **次の一歩を実行した** | **${step}件** | **${pct(step, ans7.length)}**（分母＝回答数） |`);
  L.push(`| 「今は決めない」と自分で決めた | ${undec}件 | ${pct(undec, ans7.length)} |`);
  L.push(`| 医師や家族に話せた | ${told}件 | ${pct(told, ans7.length)} |`);
  L.push("");
  L.push("> 割合の分母は**回答数**であり、送信数ではない。回答した人だけの数字であることを隠さない。");
  L.push("");
  L.push("## 2. 逆方向の数字（6ヶ月後フォロー）");
  L.push("");
  L.push("| 状態 | 実数 | 割合 |");
  L.push("|---|---|---|");
  for (const k of STATUSES) L.push(`| ${STATUS_JA[k]} | ${counts[k]}件 | ${pct(counts[k], ans6.length)} |`);
  L.push(`| **合計（回答）** | **${ans6.length}件** | **回答率 ${pct(ans6.length, sent6.length)}**（送信 ${sent6.length}件） |`);
  L.push("");
  L.push("> **どの答えも同じ重さで扱う。** 治療を続けた人の割合も、終えた人の割合も、両方を平時から出す。");
  if (ans6.length < 10) L.push("> ⚠ 回答が10件未満のため、公開に耐える水準ではない。集計の習慣を作る段階として記録のみ行う。");
  L.push("");
  L.push("## 3. 価値と支払い意思は別（失敗パターン3）");
  L.push("");
  L.push("| 良かった | 払った | 2回目も払った |");
  L.push("|---|---|---|");
  L.push(`| ${good}件 | ${paid}件 | **${repeat}件** |`);
  L.push("");
  L.push("> この3つは別の仮説である。並べて置くこと自体が予防策になる。");
  L.push("");
  L.push("## 4. 満足度が低かったセッション（実数）");
  L.push("");
  if (low.length === 0) {
    L.push("該当なし（0件）。");
  } else {
    L.push(`**${low.length}件。** 理由の内訳：`);
    L.push("");
    L.push("| 理由 | 件数 |");
    L.push("|---|---|");
    for (const [k, v] of Object.entries(lowByReason).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v}件 |`);
  }
  L.push("");
  L.push("## 5. 担当者別（Gate④：サポーターが変わっても成果を説明できるか）");
  L.push("");
  const bySup = {};
  for (const x of ans7) {
    bySup[x.supporter] ??= { n: 0, step: 0 };
    bySup[x.supporter].n++;
    if (x.f7.step === "yes") bySup[x.supporter].step++;
  }
  const rows = Object.entries(bySup).sort((a, b) => b[1].n - a[1].n);
  if (rows.length === 0) {
    L.push("回答がないため算定できません。");
  } else {
    L.push("| 担当 | 回答数 | 次の一歩を実行した | 達成率 |");
    L.push("|---|---|---|---|");
    for (const [k, v] of rows) L.push(`| ${k} | ${v.n} | ${v.step} | ${pct(v.step, v.n)} |`);
    const valid = rows.filter(([, v]) => v.n >= 5).map(([, v]) => (v.step / v.n) * 100);
    if (valid.length >= 2) {
      const diff = Math.max(...valid) - Math.min(...valid);
      L.push("");
      L.push(`**最高 − 最低 ＝ ${diff.toFixed(1)}ポイント**（回答5件以上の担当のみで算定）。基準は15pt以内。${diff <= 15 ? "**基準内。**" : "**基準超過。再研修の対象。**"}`);
    } else {
      L.push("");
      L.push("回答5件以上の担当が2名未満のため、差は算定していない。**n が小さいことを「差がない」と読まないこと。**");
    }
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("> 相談件数に目標値は置かない（失敗パターン9）。この集計に「目標」欄がないのは意図的である。");

  const out = `${L.join("\n")}\n`;
  const path = arg("out");
  if (path) {
    writeFileSync(path, out);
    console.log(`書き出しました: ${path}`);
  } else {
    process.stdout.write(out);
  }
}

// ---------------------------------------------------------------- dispatch

const HELP = `フォロー台帳｜7日後フォローと6ヶ月後フォロー（逆方向の数字）の管理

  add       セッションを登録する
            --date=YYYY-MM-DD --kind=15min|45min|90min|member --supporter=記号 --contact=外部キー
  due       送信すべきフォローを一覧する            [--today=YYYY-MM-DD]
  record    7日後フォローの回答を記録する
            --id=S-0001 --step=yes|no|other [--undecided=] [--told=] [--good=] [--low-sat --low-sat-reason=]
  record6m  6ヶ月後フォローの回答を記録する
            --id=S-0001 --status=continuing|paused|ended|undecided
  skip      送信対象から外す（理由必須）           --id= --which=7d|6m --reason=
  report    集計する                               --from= --to= [--out=path.md]

データは ${EVENTS}（追記のみ）。連絡先・氏名は保存しない。`;

const cmd = process.argv[2];
const table = { add: cmdAdd, due: cmdDue, record: cmdRecord, record6m: cmdRecord6m, skip: cmdSkip, report: cmdReport };
if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
  process.exit(0);
}
if (!table[cmd]) die(`不明なコマンド: ${cmd}\n\n${HELP}`);
table[cmd]();
