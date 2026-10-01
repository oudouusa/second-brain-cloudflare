"""合成資料だけを/chatへ直列送信し、機械チェックと目視用回答を保存する。"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import time
import unicodedata
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def inspect_answer(text, case):
    citations = {int(n) for n in re.findall(r"\[(\d+)\]", text)}
    # 日本語＋英字を想定する固定fixture専用。意味の正しさを保証しない。
    unexpected = sorted({ch for ch in text if ch.isalpha() and not any(
        name in unicodedata.name(ch, "")
        for name in ("LATIN", "HIRAGANA", "KATAKANA", "CJK", "IDEOGRAPHIC")
    )})
    years = lambda value: set(re.findall(r"(?<!\d)(?:19|20)\d{2}(?!\d)", unicodedata.normalize("NFKC", value)))
    return {
        "japanese_present": bool(re.search(r"[ぁ-んァ-ヶ]", text)),
        "unsupported_years": sorted(years(text) - years(case["memories"])),
        "nonempty": bool(text.strip()),
        "citations_in_range": citations <= set(case["source_ids"]),
        "required_citations_present": set(case["required_citations"]) <= citations,
        "unexpected_letters": unexpected,
    }



MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # 認証ヘッダーをリダイレクト先へ転送しない。
    def redirect_request(self, *args, **kwargs):
        return None


def valid_endpoint(value):
    try:
        url = urlsplit(value)
        _ = url.port
        return url.scheme == "https" and bool(url.hostname) and not any(
            (url.username, url.password, "?" in value, "#" in value))
    except ValueError:
        return False


def parse_answer_stream(raw):
    """回答経路のSSE契約を確認。本文内のDONEやlength終了は成功にしない。"""
    text, fields = [], []
    stopped = done = False
    for line in raw.splitlines():
        if line:
            if line.startswith("data:"):
                fields.append(line[5:].removeprefix(" "))
            continue
        if not fields:
            continue
        data = "\n".join(fields)
        fields = []
        if done:
            raise ValueError("terminal_event_followed_by_data")
        if data == "[DONE]":
            if not stopped:
                raise ValueError("missing_stop")
            done = True
            continue
        event = json.loads(data)
        if "error" in event:
            raise ValueError("stream_error")
        choices = event.get("choices")
        if not isinstance(choices, list):
            raise ValueError("missing_choices")
        for choice in choices:
            if stopped or choice.get("index", 0) != 0:
                raise ValueError("unexpected_choice")
            content = choice.get("delta", {}).get("content")
            if content is not None:
                if not isinstance(content, str):
                    raise ValueError("invalid_content")
                text.append(content)
            reason = choice.get("finish_reason")
            if reason is not None:
                if reason != "stop":
                    raise ValueError("incomplete_generation")
                stopped = True
    if fields or not done:
        raise ValueError("incomplete_stream")
    return {"text": "".join(text), "done": True, "finish_reason": "stop"}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True, help="認証情報を含まないWorkerのHTTPS URL")
    parser.add_argument("--output", required=True, help="新規JSONLファイル（既存は上書きしない）")
    parser.add_argument("--runs", type=int, choices=range(1, 4), default=3)
    parser.add_argument("--delay", type=float, default=5, help="各要求間の秒数、5〜60秒")
    args = parser.parse_args()
    if not valid_endpoint(args.endpoint) or not 5 <= args.delay <= 60:
        parser.error("認証情報・query・fragmentのないHTTPS URLと5〜60秒の間隔が必要です")
    token = os.environ["SB_AUTH_TOKEN"]
    cases = json.loads(Path(__file__).with_name("cases.json").read_text())
    failed = False
    with open(args.output, "x", encoding="utf-8") as output:
        for repeat in range(args.runs):
            for case in cases:
                if repeat or case is not cases[0]:
                    time.sleep(args.delay)
                row = {"case": case["id"], "repeat": repeat + 1,
                       "at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
                request = urllib.request.Request(args.endpoint.rstrip("/") + "/chat",
                    data=json.dumps({k: case[k] for k in ("query", "memories")}).encode(),
                    headers={"Authorization": "Bearer " + token,
                             "Content-Type": "application/json", "Accept": "text/event-stream",
                             "User-Agent": "SecondBrainCF-Validation/1.0"})
                start = time.monotonic()
                try:
                    try:
                        response = urllib.request.build_opener(NoRedirect).open(request, timeout=35)
                    except urllib.error.HTTPError as error:
                        response = error
                    with response:
                        row["status"] = response.status
                        raw_bytes = response.read(MAX_RESPONSE_BYTES + 1)
                        if len(raw_bytes) > MAX_RESPONSE_BYTES:
                            raise ValueError("response_too_large")
                        raw = raw_bytes.decode()
                    if row["status"] == 200:
                        row.update(parse_answer_stream(raw))
                        row["checks"] = inspect_answer(row["text"], case)
                        checks = row["checks"]
                        row["machine_pass"] = row["done"] and all(checks[k] for k in
                            ("nonempty", "japanese_present", "citations_in_range", "required_citations_present")) and not checks["unexpected_letters"] and not checks["unsupported_years"]
                except Exception as error:
                    # 例外本文やHTTPエラー本文に資格情報を混ぜない。
                    row["error_type"] = type(error).__name__
                    row["machine_pass"] = False
                row["seconds"] = round(time.monotonic() - start, 3)
                row["review_required"] = case["review"]
                failed |= not row.get("machine_pass", False)
                output.write(json.dumps(row, ensure_ascii=False) + "\n")
                output.flush()
                print(json.dumps({k: row[k] for k in ("case", "repeat", "seconds")}))
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
