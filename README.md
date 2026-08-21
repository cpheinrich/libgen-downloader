# libgen-downloader

[![npm version](https://badge.fury.io/js/libgen-downloader.svg)](https://badge.fury.io/js/libgen-downloader)

`libgen-downloader` is a command-line tool for searching and downloading ebooks from **LibGen**. Built with `Node.js`, `TypeScript`, `React`, `Ink`, and `Zustand`, it works by visiting LibGen’s web pages, parsing the HTML, and displaying results. Since it relies on LibGen’s servers, you may occasionally encounter connection errors when searching, downloading, or loading more pages.

## Important Update

After the original `libgen` mirrors are blocked and not available anymore (see their status from here https://open-slum.org/), `libgen-downloader` now uses the `libgen+` mirrors as its primary source. You can see the new available mirrors from [configuration](https://github.com/obsfx/libgen-downloader/blob/configuration/config.v3.json).

https://github.com/user-attachments/assets/3d92eb78-1567-478d-a0d1-5724f647be10

https://github.com/user-attachments/assets/9896d457-ccbf-40aa-ae6b-c253f7a97824

## Installation

if you have already installed `NodeJS` and `npm`, you can install it using `npm`:

```
npm i -g libgen-downloader
```

or you can download one of the `standalone executable` versions.

#### [Standalone Executables](https://github.com/obsfx/libgen-downloader/releases)

**macOS users:** After downloading, you need to remove the quarantine attribute and make it executable:

```bash
xattr -c ./libgen-downloader-macos-*
chmod +x ./libgen-downloader-macos-*
```

**Linux users:** Make it executable:

```bash
chmod +x ./libgen-downloader-linux-*
```

## Features

- Interactive user interface.
- Non app blocking direct downloading.
- Bulk downloading.
- Best-copy ingestion that ranks duplicate results for Docling conversion.
- Canonical library folders under `~/libgen/<author>_<title>/`.
- Markdown reading-list ingestion with `--list`.
- Local-file ingestion for books you already own with `--import`.
- Alternative download options.
- Command line parameters;

  ```
  Usage
  	$ libgen-downloader <input>

  Options
  -s, --search <query>       search for a book interactively
      --best <query>         find and ingest the best copy of a book
  -l, --list <BOOKS.md>      ingest every book in a Markdown list
  -i, --import <file>        import and convert a locally owned book
      --title <title>        override title metadata for --import
      --author <author>      override author metadata for --import
  -o, --output <directory>   library root (default: ~/libgen)
      --pages <number>       result pages to evaluate (default: 2)
      --source-only          retain sources without Docling conversion
      --markdown             also export Docling Markdown alongside native JSON
  -b, --bulk <MD5LIST.txt>   legacy MD5 bulk downloading mode
  -u, --url <MD5>            get the download URL
  -d, --download <MD5>       download the file by MD5
  -h, --help                 display help

  Examples
  $ libgen-downloader    (start the app in interactive mode without flags)
  $ libgen-downloader -s "The Art of War"
  $ libgen-downloader --best "The Art of War by Sun Tzu"
  $ libgen-downloader --best "The Art of War by Sun Tzu" --markdown
  $ libgen-downloader --list ./reading-list.md
  $ libgen-downloader --import ~/my-library/book.pdf
  $ libgen-downloader -b ./MD5_LIST_1695686580524.txt
  	$ libgen-downloader -u 1234567890abcdef1234567890abcdef
  	$ libgen-downloader -d 1234567890abcdef1234567890abcdef

  ```

### Canonical library

Best-copy and reading-list ingestion stores each work in a deterministic directory:

```text
~/libgen/
└── sun-tzu_the-art-of-war/
    ├── source.pdf
    ├── metadata.json
    ├── conversion.json
    └── docling/
        ├── source.json              # canonical DoclingDocument
        ├── source.md                # optional: add --markdown
        └── source_artifacts/        # native referenced images
```

The original server filename is never trusted. The selected source is always named
`source.<extension>`. Docling's native output is stored together and left untouched under
`docling/`. Set a different library root with `--output` or the `LIBGEN_LIBRARY_DIR` environment
variable.

Use `--import` for a local EPUB, PDF, RTF, or other supported source you already own. The importer
copies the source rather than moving it, infers `Title by Author` and `Author - Title` filenames,
and accepts `--title` and `--author` overrides when the embedded metadata is incomplete.

Docling is the only document converter. Its JSON document model is always produced and is the
canonical converted representation. Add `--markdown` to ask Docling to export Markdown from the
same parse. The package does not rewrite, normalize, add frontmatter to, or otherwise parse
Docling's Markdown. OCR, formula enrichment, and referenced images are enabled when available.

```bash
libgen-downloader --best "On the Origin of Species by Charles Darwin"
libgen-downloader --best "On the Origin of Species by Charles Darwin" --markdown
```

Automatic best-copy selection only downloads source formats Docling supports. EPUB and other
unsupported local files can still be retained with `--source-only`, but are not routed through a
second converter.

On macOS, install the converter with:

```bash
uv tool install docling
```

### Markdown reading lists

`--list` accepts bullets, task-list items, numbered items, or one plain query per line. Author hints
improve duplicate matching:

```markdown
# Reading list

- The Art of War — Sun Tzu
- [ ] Gödel, Escher, Bach by Douglas Hofstadter

1. A Brief History of Time
```

Each query is processed independently, existing canonical directories are left untouched, and the
command prints a downloaded/skipped/failed summary when complete.

Search and file delivery use separate infrastructure. If searches succeed but downloads report
that the shared file host is unreachable, try the command again on the same VPN or network path
that permits the download in your browser.

## Changelogs

v3.0.0

- Added new `libgen+` mirrors as primary source. App is now usable as long as the `libgen+` mirrors are available.
- Dropped `search by` filtering options to make it compatible with the new `libgen+` mirrors.
- Dropped `alternative downloads` feature to make it compatible with the new `libgen+` mirrors.

---

v2.0.0

- Added alternative downloads.
- Added new download progress indicators.
- Added a cache mechanism to quickly retrieve previously searched results..
- Added new CLI parameter `-s, --search` to search queries directly in the command line.
- Added new shortcut keys to simplify usage:
  - `[J]` and `[K]` to move up and down for vimmers.
  - `[TAB]` to add an entry to the bulk download queue.
  - `[D]` to download an entry directly.
- Dropped result filtering. Instead added `Search by` filtering options to filter in columns like the original libgen search functionality.

---

v1.3.7

- Changed cli module and usage.
- Refactored downloading processes.
- README simplified.

---

v1.3

- Whole app was rewritten using `React`, `Ink` and `Zustand`.
- Added result filtering.
- Now you do not have to wait while downloading files using the `direct download` option.
- New version notifier.
- Due to the https://gen.lib.rus.ec is banned in my country, now libgen-downloader fetches the latest configuration file from the [configuration](https://github.com/obsfx/libgen-downloader/tree/configuration) branch and finds an available mirror dynamically.

---

v1.2

- Direct download option added as a cli functionality.

---

v1.1

- New and mostly resizeable UI.

---

v1.0

- Addded bulk downloading
- Improved error handling.
- When a connection error occurs, `libgen-downloader` does not shut down instantly. It tries 5 times to do same request with 3 seconds of delay.
- New customized UI module.
