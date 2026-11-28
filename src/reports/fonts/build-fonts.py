#!/usr/bin/env python3
"""Cut the fonts the PDF report embeds.

The report embeds a font, because a PDF that reaches a clinician has to show
the app's language, not a row of empty boxes. A full CJK font is far too large
to ship and to embed, so each font here is cut down to the characters that
language's report can actually draw: the report's own wording, the drug, route
and form names, the locale's month names, digits and punctuation.

The upstream fonts are Noto, under the SIL Open Font License 1.1. They are
variable fonts; each is pinned to one weight, then subset. The subsets stay
TrueType outlines, because jsPDF reads glyf outlines and cannot read the
PostScript outlines a CFF font carries.

Run it after a translation changes:

    python3 src/reports/fonts/build-fonts.py

It needs `fonttools` and Node 22 on PATH. It downloads the upstream fonts
once into `node_modules/.cache/report-fonts` and reuses them afterwards.

Nothing is published until every font, the licence, the notices and the
manifest are ready, so a failure while preparing them leaves the shipped
files as they were.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

REPO = Path(__file__).resolve().parents[3]
FONT_DIR = Path(__file__).resolve().parent

# google/fonts, pinned so a rebuild produces the same bytes.
UPSTREAM_REPO = "google/fonts"
UPSTREAM_COMMIT = "5026800714d07231937d92eb4cceabf06e05d74e"
UPSTREAM_BASE = f"https://raw.githubusercontent.com/{UPSTREAM_REPO}/{UPSTREAM_COMMIT}/ofl"

WEIGHT = 400

# One file per font family, cut for the languages that read it. The Latin file
# carries every Latin-script language together: one font covers Latin, Cyrillic
# and Turkish, so splitting it would only duplicate bytes.
FONTS = {
    "latin": {
        "file": "NotoSans-Latin.ttf",
        "source": "notosans/NotoSans[wdth,wght].ttf",
        "family": "Noto Sans",
        "langs": ["en", "de", "tr", "ru", "uk"],
        "axes": {"wght": WEIGHT, "wdth": 100},
    },
    "zh": {
        "file": "NotoSansSC-zh.ttf",
        "source": "notosanssc/NotoSansSC[wght].ttf",
        "family": "Noto Sans SC",
        "langs": ["zh"],
        "axes": {"wght": WEIGHT},
    },
    "zh-TW": {
        "file": "NotoSansTC-zh-TW.ttf",
        "source": "notosanstc/NotoSansTC[wght].ttf",
        "family": "Noto Sans TC",
        "langs": ["zh-TW"],
        "axes": {"wght": WEIGHT},
    },
    "yue": {
        "file": "NotoSansHK-yue.ttf",
        "source": "notosanshk/NotoSansHK[wght].ttf",
        "family": "Noto Sans HK",
        "langs": ["yue"],
        "axes": {"wght": WEIGHT},
    },
    "ja": {
        "file": "NotoSansJP-ja.ttf",
        "source": "notosansjp/NotoSansJP[wght].ttf",
        "family": "Noto Sans JP",
        "langs": ["ja"],
        "axes": {"wght": WEIGHT},
    },
    "ko": {
        "file": "NotoSansKR-ko.ttf",
        "source": "notosanskr/NotoSansKR[wght].ttf",
        "family": "Noto Sans KR",
        "langs": ["ko"],
        "axes": {"wght": WEIGHT},
    },
}


def download(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  fetching {url}")
    with urllib.request.urlopen(url) as response:
        target.write_bytes(response.read())


def source_font(name: str, cache: Path) -> Path:
    target = cache / name
    download(f"{UPSTREAM_BASE}/{name}", target)
    return target


def charsets() -> dict[str, str]:
    """The characters each language's report can draw."""
    entry = FONT_DIR / "charsetEntry.ts"
    with tempfile.TemporaryDirectory() as tmp:
        bundle = Path(tmp) / "charset.mjs"
        subprocess.run(
            [
                "npx",
                "esbuild",
                str(entry),
                "--bundle",
                "--format=esm",
                "--platform=node",
                f"--outfile={bundle}",
                "--log-level=error",
            ],
            check=True,
            cwd=REPO,
        )
        result = subprocess.run(
            ["node", str(bundle)], check=True, cwd=REPO, capture_output=True, encoding="utf-8"
        )
    return json.loads(result.stdout)


def subset_font(source: Path, characters: str, axes: dict[str, float], out: Path) -> list[str]:
    """Pin the weight, cut to the characters, and report what did not fit."""
    font = TTFont(source, recalcTimestamp=False)
    if "fvar" in font:
        font = instancer.instantiateVariableFont(font, axes, updateFontNames=True)

    options = Options()
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.recommended_glyphs = True
    # Shaping tables are for a text engine; a PDF draws one glyph at a time.
    options.layout_features = []
    options.hinting = False
    options.glyph_names = False
    options.legacy_kern = False
    options.drop_tables += ["DSIG"]

    subsetter = Subsetter(options)
    subsetter.populate(text=characters)
    subsetter.subset(font)

    covered = set(font.getBestCmap().keys())
    missing = sorted({ord(c) for c in characters if ord(c) not in covered})

    if not missing:
        font.save(out)
    font.close()
    return [chr(code) for code in missing]


def format_manifest(manifest_path: Path) -> None:
    """Format the manifest the way the repository formats JSON."""
    command = ["npx", "prettier"]
    config = REPO / ".prettierrc.json"
    if config.exists():
        # The manifest is formatted where it is staged, which can sit outside
        # the repository, so the configuration is named rather than looked up.
        command += ["--config", str(config)]
    command.append(str(manifest_path))
    try:
        result = subprocess.run(
            command,
            check=True,
            cwd=REPO,
            capture_output=True,
            encoding="utf-8",
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("  (prettier was not available; the manifest may need formatting)")
        return
    if not result.stdout.strip():
        print("  (prettier returned no output; the manifest may need formatting)")
        return
    manifest_path.write_bytes(result.stdout.encode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", default=str(REPO / "node_modules" / ".cache" / "report-fonts"))
    parser.add_argument("--out", default=str(FONT_DIR))
    args = parser.parse_args()

    cache = Path(args.cache)
    out_dir = Path(args.out)
    per_language = charsets()

    manifest = {
        "upstream": {
            "repository": UPSTREAM_REPO,
            "commit": UPSTREAM_COMMIT,
            "license": "SIL Open Font License 1.1",
        },
        "weight": WEIGHT,
        "fonts": {},
        "charsets": per_language,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    public_licenses = REPO / "public" / "licenses"
    public_licenses.mkdir(parents=True, exist_ok=True)
    # Everything is prepared in staging first. The shipped files are replaced
    # only once every font, the licence, the notices and the manifest are
    # ready, so a failure while preparing them leaves them as they were.
    # Each output is staged on the filesystem it is published on, so it is
    # replaced rather than copied.
    prepared: list[tuple[Path, Path]] = []
    with tempfile.TemporaryDirectory(prefix=".report-fonts-", dir=out_dir) as tmp, tempfile.TemporaryDirectory(
        prefix=".report-fonts-", dir=public_licenses
    ) as public_tmp:
        staged = Path(tmp)
        staged_public = Path(public_tmp)
        incomplete = False
        for group, spec in FONTS.items():
            languages = spec["langs"]
            characters = "".join(sorted(set("".join(per_language[lang] for lang in languages))))
            source = source_font(spec["source"], cache)
            target = staged / spec["file"]
            missing = subset_font(source, characters, spec["axes"], target)
            if missing:
                # One run reports every locale that is short, not just the first.
                incomplete = True
                codes = " ".join(f"U+{ord(char):04X}" for char in missing[:20])
                print(f"{spec['file']}: missing {len(missing)} glyphs ({codes})", file=sys.stderr)
                continue
            size = target.stat().st_size
            print(f"{spec['file']}: {len(characters)} characters, {size // 1024} KiB")
            manifest["fonts"][group] = {
                "file": spec["file"],
                "source": spec["source"],
                "family": spec["family"],
                "langs": languages,
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "bytes": size,
                "characters": len(characters),
            }
            prepared.append((target, out_dir / spec["file"]))

        if incomplete:
            return 1

        # The licence travels with the font, and with the distribution: the file in
        # public/ is copied into the built site and into the Android package, so a
        # copy of the app carries the terms the font is under.
        license_text = cache / "OFL.txt"
        download(f"{UPSTREAM_BASE}/notosans/OFL.txt", license_text)
        ofl = "\n".join(line.rstrip() for line in license_text.read_text(encoding="utf-8").splitlines()) + "\n"
        (staged / "LICENSE.txt").write_text(ofl, encoding="utf-8")
        prepared.append((staged / "LICENSE.txt", out_dir / "LICENSE.txt"))

        # The notices are staged next to where they are published, so each one
        # is replaced in place.
        (staged_public / "noto-sans-OFL-1.1.txt").write_text(ofl, encoding="utf-8")
        notice = (FONT_DIR / "THIRD-PARTY-NOTICES.txt").read_text(encoding="utf-8")
        notice = notice.replace("{{COMMIT}}", UPSTREAM_COMMIT)
        (staged_public / "THIRD-PARTY-NOTICES.txt").write_text(notice, encoding="utf-8")
        prepared.append((staged_public / "noto-sans-OFL-1.1.txt", public_licenses / "noto-sans-OFL-1.1.txt"))
        prepared.append((staged_public / "THIRD-PARTY-NOTICES.txt", public_licenses / "THIRD-PARTY-NOTICES.txt"))

        manifest_path = staged / "manifest.json"
        manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        manifest_path.write_bytes(manifest_json.encode("utf-8"))
        # The repository checks its own formatting, and the manifest is part of it.
        format_manifest(manifest_path)
        prepared.append((manifest_path, out_dir / "manifest.json"))

        # Nothing above touched a shipped file. Publish the prepared ones.
        for staged_file, final in prepared:
            final.parent.mkdir(parents=True, exist_ok=True)
            staged_file.replace(final)

    return 0


if __name__ == "__main__":
    sys.exit(main())
