# Subtitle Font Bridge Web build

This fork keeps the **official Jellyfin Web source** as its base and carries one
small integration patch: `patches/jellyfin-web-enhancements.patch`.

The patch contains three focused playback improvements:

- **Subtitle Font Bridge:** asks the installed server plugin which ASS font
  families are used, then passes authenticated system-font URLs to
  `@jellyfin/libass-wasm` as `availableFonts` with lazy file loading. This avoids
  waiting for Jellyfin to extract every attached MKV font before first render;
  embedded attachments remain the fallback when Bridge is unavailable or cannot
  resolve every requested family.
- **Hold for 2×:** keeps Jellyfin Web's playback-manager, OSD, keyboard, mouse,
  and touch integration for temporary 2× playback.
- **Outro skip with Up Next:** keeps the outro skip button visible even when the
  Next Video overlay is enabled. It measures the displayed Up Next card and
  animates the skip button above it, returning it to the default position when
  the card is hidden.

## Automatic releases

`.github/workflows/bridge-release.yml` polls official Jellyfin Web releases
daily and can also be started manually. For each unprocessed upstream tag it:

1. checks out the official tag;
2. applies the Bridge patch with `git apply --3way`;
3. runs TypeScript checks and the Bridge resolver test;
4. builds production `dist` assets;
5. pushes a `bridge/<upstream-tag>` source branch and `<upstream-tag>-bridge.1`
tag; and
6. creates a GitHub Release containing a ZIP of `dist` and its SHA-256 file.

If the official Web changes the relevant playback code and the patch no longer
applies or validates, the workflow fails before any branch, tag, or release is
created. Update the patch deliberately for that upstream version, then re-run
the workflow.

The workflow needs the repository Actions setting **Workflow permissions** set
to **Read and write permissions** so `GITHUB_TOKEN` can create branches, tags,
and releases.