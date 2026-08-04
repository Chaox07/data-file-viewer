# Data File Viewer

A VS Code extension that opens `.duckdb`, `.parquet`, and `.db`/`.sqlite`
(SQLite) files with a table list ("sheets") in the sidebar, an editable SQL
query box, and a results grid — modeled on
[caioricciuti/vs-duckdb-viewer](https://github.com/caioricciuti/vs-duckdb-viewer).
DuckDB is the engine reading all these formats under the hood.

`.duckdb` and `.parquet` files open automatically on double-click. `.db`/
`.sqlite` are **not** automatic (they're generic extensions used by many
unrelated file formats) — right-click such a file and choose "Open With..."
→ "Data File Viewer (SQLite)", or use the Command Palette's "Reopen Editor
With..." on an already-open one. Opening a `.db`/`.sqlite` file also requires
DuckDB to load its `sqlite` extension, which needs an internet connection the
*first* time it's used on a given machine (cached locally after that).

`.parquet` files aren't databases with multiple tables, so they're exposed as
a single view named after the file — the sidebar will show just that one
entry, and clicking it previews the file's data like any other table.

## Local development

```sh
npm install
npm run build      # one-off build (esbuild -> dist/extension.js, dist/webview.js)
npm run watch       # rebuild on file changes
```

Press `F5` in VS Code (with this folder open) to launch an Extension Development
Host, then open any `.duckdb`/`.parquet`/`.db`/`.sqlite` file in that window.

## Packaging

```sh
npm run package     # builds, then runs vsce package -> data-file-viewer-x.x.x.vsix
code --install-extension data-file-viewer-0.0.1.vsix
```

`@duckdb/node-api` ships platform-specific native binaries resolved at
`npm install` time. **A `.vsix` built on one OS will not work on another** —
do not copy it across machines. Build separately per platform, or use the
GitHub Actions workflow below to get both automatically.

## CI (GitHub Actions)

`.github/workflows/build.yml` builds a macOS and a Windows `.vsix` on every
push, using GitHub-hosted runners — no local Node/npm/vsce needed on a machine
that only needs to *install* the extension.

Every push to `main` also publishes both `.vsix` files to a rolling
[**`latest` release**](https://github.com/Chaox07/data-file-viewer/releases/tag/latest)
— one permanent URL that's always overwritten with the newest build, so you
don't have to dig through the Actions tab or worry about the 90-day artifact
expiry below. Download the platform-tagged `.vsix` (`...-macos-latest.vsix` /
`...-windows-latest.vsix`) for your machine, then:

```sh
code --install-extension <downloaded-file>.vsix
```

If you need a specific run's build instead of always-latest: open the repo's
**Actions** tab, pick that run, and download its `vsix-macos-latest` /
`vsix-windows-latest` artifact. Unlike the `latest` release above, these
per-run artifacts expire after 90 days by default.

## Making `.duckdb`/`.parquet` files open in VS Code on double-click

This is a one-time OS setting per machine — VS Code extensions can't register
this automatically:

- **macOS**: right-click a `.duckdb` or `.parquet` file → Get Info → "Open
  with" → select Visual Studio Code → "Change All…".
- **Windows**: right-click a `.duckdb` or `.parquet` file → "Open with" →
  "Choose another app" → Visual Studio Code → check "Always use this app to
  open this file type".

Once set, double-clicking either file type anywhere launches VS Code directly
into this custom editor. `.db`/`.sqlite` files are opened manually via
right-click, as described above — no OS file-association step needed (or
wanted) for those.
