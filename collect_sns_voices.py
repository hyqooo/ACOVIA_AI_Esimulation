"""
ACOVIA向け：Grok API（x_search）を使って、不妊治療の長期治療者が
Xに投稿している「生の声」を集め、sns-customer-voices.md に書き出すスクリプト。

事前準備：
1. https://console.x.ai でAPIキーを取得する
2. ターミナルで以下を実行してから、このスクリプトと同じターミナルで実行する
   export GROK_API_KEY="ここに取得したAPIキー"
   ※APIキーはチャットやコードに直接書き込まないこと
3. 必要なライブラリをインストール
   pip install requests --break-system-packages

実行方法：
   python3 collect_sns_voices.py
"""

import os
import json
import time
import requests

API_KEY = xai-I3QsgfHFVHxy7fePvp0ER4dgWqpiTrPTIqmBuWBlgR9XrMk9h6Paf0280kJoM2utRQ8GyVHx8TZf0CW9
if not API_KEY:
    raise SystemExit(
        "環境変数 GROK_API_KEY が設定されていません。\n"
        "ターミナルで export GROK_API_KEY=\"あなたのキー\" を実行してから、\n"
        "もう一度このスクリプトを実行してください。"
    )

URL = "https://api.x.ai/v1/responses"
MODEL = "grok-4-1-fast"

# ACOVIAの検証中の仮説に沿った検索クエリ。
# 「個人が特定できない形で」「ユーザー名は伏せて」を必ず入れ、
# プライバシーに配慮した要約のみを取得する。
QUERIES = [
    "不妊治療を2年以上続けている人が、Xで最近つぶやいている「つらさ」「本音」を、"
    "個人が特定できない形でテーマ別に要約してください。ユーザー名や個人が特定できる情報は伏せてください。",

    "体外受精や人工授精を長期間続けている人が、「治療をいつまで続けるか」「やめどき」に"
    "ついて書いているXの投稿を、テーマ別に要約してください。ユーザー名は伏せてください。",

    "不妊治療中の人が「誰にも本音を言えない」「孤独を感じる」ということについて書いている"
    "Xの投稿を、要約してください。ユーザー名は伏せてください。",

    "不妊治療の経験者（治療を終えた人も含む）が、当時「こんなサービスや支援があれば"
    "良かった」と感じたことについて書いているXの投稿があれば、要約してください。"
    "ユーザー名は伏せてください。",

    "不妊治療において、パートナー（夫・妻）との温度差や、支えてほしい・支えられなかった"
    "という経験について書かれているXの投稿を、要約してください。ユーザー名は伏せてください。",
]


def ask_grok(query: str) -> dict:
    payload = {
        "model": MODEL,
        "input": [{"role": "user", "content": query}],
        "tools": [{"type": "x_search"}],
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }
    resp = requests.post(URL, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    return resp.json()


def extract_text(result: dict) -> str:
    """Responses APIのレスポンスからテキスト部分を取り出す。
    構造が想定と違う場合は生のJSONをそのまま返す（中身を失わないため）。"""
    try:
        output = result.get("output", [])
        texts = []
        for item in output:
            if item.get("type") == "message":
                for c in item.get("content", []):
                    if c.get("type") in ("output_text", "text"):
                        texts.append(c.get("text", ""))
        if texts:
            return "\n".join(texts)
    except Exception:
        pass
    return "```json\n" + json.dumps(result, ensure_ascii=False, indent=2) + "\n```"


def main():
    sections = []
    for i, q in enumerate(QUERIES, start=1):
        print(f"[{i}/{len(QUERIES)}] 検索中...")
        try:
            result = ask_grok(q)
            text = extract_text(result)
        except Exception as e:
            text = f"(エラーが発生しました: {e})"
        sections.append(f"## クエリ{i}\n\n**質問**：{q}\n\n**結果**：\n\n{text}\n")
        time.sleep(2)  # API負荷軽減のための小休止

    header = (
        "# SNSから収集した顧客の生の声（Grok API / X検索）\n\n"
        "収集日: 実行時点\n"
        "注記: これはインタビューの代わりに、Grok APIのX検索機能を使って収集した"
        "一次情報の要約です。個人が特定できる情報は含めないよう指示していますが、"
        "実際の事業判断に使う際は、可能であれば直接インタビューでの裏取りも検討してください。\n\n"
        "---\n\n"
    )
    output_md = header + "\n---\n\n".join(sections)

    with open("sns-customer-voices.md", "w", encoding="utf-8") as f:
        f.write(output_md)

    print("完了：sns-customer-voices.md に書き出しました")


if __name__ == "__main__":
    main()
