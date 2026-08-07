# フォロー台帳

7日後フォローと6ヶ月後フォロー（＝逆方向の数字）の配信管理と集計。

## なぜ必要か

本命シナリオで、2029年に外部メディアの見出しを差し替えさせた反証材料は、**6ヶ月後フォローの最後の1問（「いま治療はどうされていますか」）の2年分の集計**だった。

> **保険は事故の後には買えない。** 件数が少ないうちから集計の習慣を作らないと、3年後には作れない。

だから**有償1件目から**回す。

## 使い方

```bash
# セッションを登録（--contact は予約/決済システム側のキー。氏名・メールは入れない）
node followup.mjs add --date=2026-09-08 --kind=45min --supporter=A --contact=tx_8f21

# 今日送るべきフォローを出す
node followup.mjs due

# 7日後フォローの回答を記録（--step は Gate② の主指標なので必須）
node followup.mjs record --id=S-0001 --step=yes --undecided=no --told=yes --good=yes

# 満足度が低かった場合（年次レポートには実数で載せる）
node followup.mjs record --id=S-0002 --step=no --low-sat --low-sat-reason="話す時間が足りなかった"

# 6ヶ月後フォロー＝逆方向の数字
node followup.mjs record6m --id=S-0001 --status=continuing   # continuing|paused|ended|undecided

# 送らなかった場合は理由を必ず残す
node followup.mjs skip --id=S-0003 --which=7d --reason="本人希望（連絡不要）"

# 集計（年次レポートの元データ）
node followup.mjs report --from=2027-01-01 --to=2027-12-31 --out=report-2027.md
```

## 設計上、意図的にそうしてあること

| | なぜ |
|---|---|
| **回答率を必ず併記する** | 回答した人だけの数字であることを隠さない（年次レポートの様式） |
| **割合の分母は回答数**（送信数ではない） | 未回答を「該当なし」に潜り込ませない |
| **送信予定日が到来したものだけを分母に数える** | まだ来ていないフォローを未回答として数えない |
| **満足度が低かったセッションは実数で出す** | 率に丸めると、件数が増えるほど見えなくなる |
| **連絡先を持たない** | `--contact` は外部システムのキー。`@` を含む値は拒否する（同意文書5項） |
| **「目標」欄がない** | 相談件数をKPIにしない（失敗パターン9） |
| **追記のみ**（`events.jsonl`） | 過去の記録を書き換えない |
| **回答10件未満は「公開に耐えない」と明記する** | 少ないnを率で語らせない |

## データ

`data/events.jsonl`（`FOLLOWUP_DATA_DIR` で変更可）。**gitにコミットしないこと。** `ACOVIA_AI_Esimulation` は公開リポジトリである。`.gitignore` 済み。
