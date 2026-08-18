# Jellyfin Web enhancements build

This fork keeps the **official Jellyfin Web source** as its base and carries one
reproducible compatibility patch: `patches/jellyfin-web-enhancements.patch`.
The patch contains every changed and newly added upstream source file required
to build the enhanced Web client; it does not depend on uncommitted files from
this repository.

The patch contains four focused playback improvements:

- **Subtitle Font Bridge:** asks the installed server plugin which ASS font
  families are used, then preloads only the required authenticated system-font files into
  `@jellyfin/libass-wasm`. This avoids waiting for Jellyfin to extract every
  attached MKV font before first render; embedded attachments remain the fallback
  when Bridge is unavailable or cannot resolve every requested family.
- **Managed text subtitles:** owns ASS/SSA and SRT selection, cancellation,
  buffering, seeking, renderer replacement, and failure recovery in a small set
  of TypeScript modules. Bitmap subtitles and unsupported/local playback paths
  continue to use Jellyfin Web's original implementation.
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
2. applies the complete compatibility patch with `git apply --3way`;
3. runs TypeScript checks, every custom subtitle test, the Bridge resolver
   tests, and ESLint on the integration files;
4. builds production `dist` assets;
5. pushes a versioned source branch and `<upstream-tag>.patch.<YYYYMMDD.N>`
   tag; and
6. creates a GitHub Release containing
   `jellyfin-web-<complete-release-tag>-dist.zip` and its SHA-256 file.

If the official Web changes the relevant playback code and the patch no longer
applies or validates, the workflow fails before any branch, tag, or release is
created. Update the patch deliberately for that upstream version, then re-run
the workflow.

## Updating the compatibility patch

`patches/upstream-base.txt` records the official tag from which the current
source changes were developed. After changing an enhancement, regenerate the
patch from the repository root:

```sh
node scripts/update-enhancement-patch.mjs
```

The generator uses an explicit source-path allowlist and also includes
untracked new files, so running it before the final commit is safe and produces
the same patch that CI will apply. Verify the result against the recorded base
and current `upstream/master`, then run the custom tests and a production build.

`patches/version.txt` is the patch build version in `YYYYMMDD.N` form. Use the
Korean calendar date on which the patch was finalized and increment `N` when
publishing another build on the same day. For example, builds finalized on
2026-08-18 are `20260818.1`, `20260818.2`, and so on. The complete release tag
for official `v12.0-rc5` is therefore `v12.0-rc5.patch.20260818.1`.

The workflow skips a release when that complete tag already exists, even if its
daily schedule runs again before Jellyfin Web publishes another official tag.

The workflow needs the repository Actions setting **Workflow permissions** set
to **Read and write permissions** so `GITHUB_TOKEN` can create branches, tags,
and releases.
