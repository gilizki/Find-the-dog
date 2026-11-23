"""Writes manifest.json in each sound folder (assets/barks, assets/ambient, assets/birds).

Browsers can't list directories, so the game reads these manifests to find your recordings.
run.bat / npm start run this automatically; run it by hand after adding/removing files if you use
another server:

    python tools/make_manifests.py
"""
import json
import pathlib

AUDIO_EXTENSIONS = {".wav", ".mp3", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".webm"}
FOLDERS = ["barks", "ambient", "birds"]

assets = pathlib.Path(__file__).resolve().parent.parent / "assets"
for name in FOLDERS:
    folder = assets / name
    folder.mkdir(parents=True, exist_ok=True)
    files = sorted(
        (p.name for p in folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS),
        key=str.lower,
    )
    (folder / "manifest.json").write_text(json.dumps({"files": files}, indent=2) + "\n", encoding="utf-8")
    print(f"assets/{name}/manifest.json: {len(files)} file(s)" + (f" -> {', '.join(files)}" if files else ""))
