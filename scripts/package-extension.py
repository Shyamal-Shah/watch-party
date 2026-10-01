"""Create a shareable extension ZIP using only Python's standard library."""

import json
from pathlib import Path
import re
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "extension"
# Explicit release contents keep unrelated files out of the shared archive.
# Add new extension assets here when introducing them.
FILES = (
    "manifest.json", "shared.js", "background.js",
    "content.js", "content.css",
    "popup.html", "popup.js", "popup.css",
    "call.html", "call.js", "call.css", "INSTALL.txt",
)


def main():
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){0,3}", version):
        raise ValueError("Invalid extension version in manifest.json")
    for name in FILES:
        source = SOURCE / name
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"Expected a regular extension file: {name}")

    destination = ROOT / "dist"
    destination.mkdir(exist_ok=True)
    output = destination / f"watch-party-extension-v{version}.zip"
    with tempfile.NamedTemporaryFile(dir=destination, suffix=".zip", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED) as archive:
            for name in FILES:
                archive.write(SOURCE / name, arcname=name)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Created {output.relative_to(ROOT)} ({output.stat().st_size:,} bytes)")
    print("Share this ZIP. Extract it, then load the extracted folder in Chrome.")


if __name__ == "__main__":
    main()
