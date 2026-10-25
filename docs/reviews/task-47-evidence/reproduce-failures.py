"""QA harness: run after preparing data/qa5/repro and sourcing data/qa5/env.sh.

The local renderer copy differs only in the absolute GNU time executable path.
The font override uses the submitted CLI option. No application code is fixed.
"""
import hashlib
import json
from pathlib import Path
import subprocess

out = Path("/workspace/data/qa5/repro")
font = "/workspace/data/qa5/deps/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"


def snapshot():
    files = sorted((out / "assets").glob("*")) + [out / "sample.mp4"]
    assert len(files) > 1 and all(p.is_file() for p in files)
    return {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in files}


before = snapshot()
for name, args in [
    ("abort", ["--fontfile", font, "--kill-after", "2"]),
    ("missing-font", ["--fontfile", "/nonexistent/font.ttc"]),
    ("fsize-limit", ["--fontfile", font, "--ulimit-kb", "512"]),
]:
    result = subprocess.run(
        ["node", "data/qa5/render-copy/render.mjs", "render", "--out", str(out), *args],
        capture_output=True, text=True, timeout=120)
    raw = result.stdout.strip() or result.stderr.strip()
    payload = json.loads(raw)
    preserved = snapshot() == before
    cleaned = not (out / ".tmp-render").exists()
    print(json.dumps({"case": name, "returncode": result.returncode,
                      "preserved": preserved, "cleaned": cleaned,
                      "result": payload}, ensure_ascii=False), flush=True)
    assert result.returncode != 0 and payload["published"] is False
    assert preserved and cleaned
    if name == "abort":
        assert payload["signal"] == "SIGKILL" or payload["exit"] == 137
    elif name == "missing-font":
        assert result.returncode == 3 and payload["error"] == "FONT_MISSING_OR_NO_HANGUL"
    else:
        assert "File too large" in payload["ffmpegStderrTail"]
