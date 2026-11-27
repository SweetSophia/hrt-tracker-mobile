# Report fonts

The PDF report embeds a font, because a report that reaches a clinician has to show the app's
language. The standard PDF fonts cannot: they are Latin-only.

These are subsets of the Noto fonts, cut down to the characters each language's report can
actually draw. A full CJK font is several megabytes; a subset is a few tens of kilobytes, which
is what keeps a report small enough to send.

## What is here

| File                   | Family       | Languages          |
| ---------------------- | ------------ | ------------------ |
| `NotoSans-Latin.ttf`   | Noto Sans    | en, de, tr, ru, uk |
| `NotoSansSC-zh.ttf`    | Noto Sans SC | zh                 |
| `NotoSansTC-zh-TW.ttf` | Noto Sans TC | zh-TW              |
| `NotoSansHK-yue.ttf`   | Noto Sans HK | yue                |
| `NotoSansJP-ja.ttf`    | Noto Sans JP | ja                 |
| `NotoSansKR-ko.ttf`    | Noto Sans KR | ko                 |

`manifest.json` records the upstream commit, the characters each subset covers, and the size and
digest of each file.

## Licence

The Noto fonts are under the SIL Open Font License 1.1 (`LICENSE.txt`). The same licence text and
a third-party notice are copied into `public/licenses/` by the build, so the built site and the
Android package carry them.

## Rebuilding

After a translation changes, the fonts have to be cut again, or the report draws boxes where the
new wording is:

    python3 src/reports/fonts/build-fonts.py

It needs `fonttools` and Node 22. It downloads the upstream fonts once into
`node_modules/.cache/report-fonts` and reuses them afterwards. The test `tests/reportsPdf.test.ts`
fails when the shipped subsets no longer cover the report's wording.
