import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const patchesDirectory = path.join(repositoryRoot, 'patches');
const baseRefFile = path.join(patchesDirectory, 'upstream-base.txt');
const outputFile = path.join(patchesDirectory, 'jellyfin-web-enhancements.patch');

// Only these paths are copied into official Jellyfin Web releases. Keeping the
// list explicit prevents documentation, automation, or local-only files from
// accidentally becoming part of the compatibility patch.
const enhancementPaths = [
    'src/apps/legacy/controllers/playback/video/index.js',
    'src/components/playback/skipbutton.scss',
    'src/components/playback/skipsegment.ts',
    'src/plugins/htmlVideoPlayer/plugin.js',
    'src/plugins/htmlVideoPlayer/style.scss',
    'src/plugins/htmlVideoPlayer/subtitleFontBridgeResolver.ts',
    'src/plugins/htmlVideoPlayer/subtitles',
    'src/styles/videoosd.scss',
    'src/types/libass-wasm.d.ts',
    'src/utils/subtitleFontBridgeResolver.test.ts'
];

function runGit(arguments_, acceptedExitCodes = [ 0 ]) {
    // This developer-only script intentionally uses the Git executable selected
    // by the caller's trusted PATH, matching every other repository Git command.
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const result = spawnSync('git', arguments_, {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
    });

    if (!acceptedExitCodes.includes(result.status ?? -1)) {
        process.stderr.write(result.stderr || Buffer.alloc(0));
        throw new Error(`git ${arguments_.join(' ')} failed with exit code ${result.status}`);
    }

    return result.stdout || Buffer.alloc(0);
}

function withTrailingNewline(buffer) {
    if (buffer.length === 0 || buffer.at(-1) === 0x0A) return buffer;
    return Buffer.concat([ buffer, Buffer.from('\n') ]);
}

const configuredBaseRef = fs.readFileSync(baseRefFile, 'utf8').trim();
const baseRef = process.argv[2]?.trim() || configuredBaseRef;
if (!baseRef) {
    throw new Error('An upstream base ref is required.');
}

runGit([ 'rev-parse', '--verify', `${baseRef}^{commit}` ]);

const patchChunks = [];
const trackedPatch = runGit([
    'diff',
    '--binary',
    '--full-index',
    '--no-ext-diff',
    baseRef,
    '--',
    ...enhancementPaths
]);
if (trackedPatch.length > 0) {
    patchChunks.push(withTrailingNewline(trackedPatch));
}

const untrackedFiles = runGit([
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    ...enhancementPaths
])
    .toString('utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

for (const untrackedFile of untrackedFiles) {
    const filePatch = runGit([
        'diff',
        '--no-index',
        '--binary',
        '--full-index',
        '--',
        '/dev/null',
        untrackedFile
    ], [ 0, 1 ]);
    patchChunks.push(withTrailingNewline(filePatch));
}

if (patchChunks.length === 0) {
    throw new Error(`No enhancement changes were found relative to ${baseRef}.`);
}

const patch = Buffer.concat(patchChunks);
fs.writeFileSync(outputFile, patch);

const changedPaths = [ ...patch.toString('utf8').matchAll(/^diff --git a\/(.+?) b\//gmu) ]
    .map(match => match[1]);
console.log(`Updated ${path.relative(repositoryRoot, outputFile)} from ${baseRef}.`);
console.log(`Included ${changedPaths.length} paths (${patch.length} bytes).`);
for (const changedPath of changedPaths) {
    console.log(`  ${changedPath}`);
}
