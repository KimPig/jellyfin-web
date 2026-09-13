/* eslint-disable compat/compat -- Developer test runs in Node 24 and current Chromium. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Optional tooling stays outside the production dependency lockfile.
// PLAYWRIGHT_MODULE can point to an external playwright/index.mjs installation.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?
    pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'jellyfin-ass-test-'));
const videoFile = path.join(temporary, 'fixture.mp4');
// Developer tooling uses the caller's trusted PATH, just like the patch generator.
// eslint-disable-next-line sonarjs/no-os-command-from-path
const ffmpeg = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=24',
    '-t', '60', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile
], { windowsHide: true });
assert.equal(ffmpeg.status, 0, ffmpeg.stderr?.toString() || 'ffmpeg is required');

const bundled = await build({
    absWorkingDir: root,
    plugins: process.env.ASS_SOURCE_REF ? [{
        name: 'subtitle-revision',
        setup(builder) {
            builder.onLoad({ filter: /[\\/]subtitles[\\/].*\.ts$/ }, ({ path: sourcePath }) => {
                const relative = path.relative(root, sourcePath).split(path.sep).join('/');
                // eslint-disable-next-line sonarjs/no-os-command-from-path
                const result = spawnSync('git', ['show', `${process.env.ASS_SOURCE_REF}:${relative}`], {
                    cwd: root, encoding: 'utf8', windowsHide: true
                });
                assert.equal(result.status, 0, result.stderr);
                return { contents: result.stdout, loader: 'ts' };
            });
        }
    }] : [],
    stdin: {
        resolveDir: root,
        contents: `
import { createAssRendererAdapter } from './src/plugins/htmlVideoPlayer/subtitles/renderers/AssRendererAdapter';
import { TextSubtitlePipeline } from './src/plugins/htmlVideoPlayer/subtitles/TextSubtitlePipeline';
import { TextEventRenderer } from './src/plugins/htmlVideoPlayer/subtitles/renderers/TextEventRenderer';
const video = document.querySelector('video');
const changes = [];
let pipeline;
function reset() {
    pipeline?.dispose();
    pipeline = new TextSubtitlePipeline(video, { onStateChange: change => changes.push(change) });
}
reset();
const factory = (request, slow, legacy, badFont) => createAssRendererAdapter({
    videoElement: video,
    subtitleUrl: location.origin + (slow ? '/slow.ass' : '/subtitle.ass'),
    fonts: [location.origin + (badFont ? '/bad-font' : slow ? '/slow-font.woff2' : '/font.woff2')],
    fallbackFonts: [location.origin + '/font.woff2'],
    workerUrl: location.origin + '/lib/subtitles-octopus-worker' + (legacy ? '-legacy' : '') + '.js',
    legacyWorkerUrl: location.origin + '/lib/subtitles-octopus-worker-legacy.js',
    baseTimeOffsetSeconds: 0,
    targetFps: 24,
    request
});
window.fixture = {
    video, changes, reset,
    select: (slow = false, legacy = false, badFont = false, slot = 0) =>
        pipeline.select(slot, 2, request => factory(request, slow, legacy, badFont)),
    text: () => pipeline.select(0, 1, async () => new TextEventRenderer({
        parentElement: video.parentElement, slot: 0,
        trackEvents: [{ StartPositionTicks: 0, EndPositionTicks: 600000000, Text: 'SRT fixture' }],
        baseTimeOffsetSeconds: 0, secondaryBeforePrimary: false, applyAppearance: () => {}
    })),
    clear: () => pipeline.clear(),
    active: () => pipeline.getActiveTrackIndex(0),
    renderer: () => pipeline.slots.get(0)?.active?.renderer,
    pixels: () => {
        const canvas = document.querySelector('.subtitle-pipeline-ass canvas');
        if (!canvas) return 0;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
        return count;
    }
};`
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome100'
});

const subtitle = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,32,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:20.00,Default,,0,0,0,,ASS READY
Dialogue: 0,0:00:30.00,0:01:00.00,Default,,0,0,0,,{\\move(80,80,400,80)}ANIMATED
`;
const library = path.join(root, 'node_modules/@jellyfin/libass-wasm/dist/js');
const requests = [];
async function serveVideo(req, res) {
    const data = await readFile(videoFile);
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/u);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : data.length - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
        res.end(data.subarray(start, end + 1));
    } else { res.end(data); }
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname);
    try {
        if (url.pathname.startsWith('/slow')) await new Promise(resolve => setTimeout(resolve, 1_500));
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><div style="position:relative;width:640px;height:360px"><video muted playsinline src="/fixture.mp4" style="width:100%;height:100%"></video></div><script src="/test.js"></script>');
        } else if (url.pathname === '/test.js') {
            res.setHeader('Content-Type', 'text/javascript');
            res.end(bundled.outputFiles[0].contents);
        } else if (url.pathname.endsWith('.ass')) {
            res.end(subtitle);
        } else if (url.pathname === '/bad-font') {
            res.writeHead(500).end('font unavailable');
        } else if (url.pathname.endsWith('.woff2')) {
            res.end(await readFile(path.join(library, 'default.woff2')));
        } else if (url.pathname === '/fixture.mp4') {
            await serveVideo(req, res);
        } else if (/^\/lib\/subtitles-octopus-worker(?:-legacy)?\.(?:js|wasm)$/u.test(url.pathname)) {
            res.setHeader('Content-Type', url.pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
            res.end(await readFile(path.join(library, path.basename(url.pathname))));
        } else { res.writeHead(404).end(); }
    } catch (error) {
        res.writeHead(500).end(String(error));
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE || undefined
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.fixture?.video.readyState >= 2);
    await page.evaluate(() => window.fixture.video.play());
    await page.evaluate(() => window.fixture.select(true));
    assert.equal(await page.evaluate(() => window.fixture.active()), 2);
    assert.ok(await page.evaluate(() => window.fixture.pixels()) > 0, 'slow initial ASS must render without seeking');
    console.log('PASS: delayed ASS and font loading, initial playback without seek');

    await page.evaluate(() => window.fixture.text());
    await page.evaluate(() => {
        window.switching = window.fixture.select(true);
    });
    assert.equal(await page.evaluate(() => window.fixture.active()), 1);
    await page.evaluate(() => window.switching);
    assert.ok(await page.evaluate(() => window.fixture.pixels()) > 0);
    console.log('PASS: delayed SRT to ASS keeps the previous track until rendering completes');

    await page.evaluate(() => {
        window.fixture.video.pause();
        window.fixture.video.currentTime = 8;
    });
    await page.waitForFunction(() => !window.fixture.video.seeking && window.fixture.pixels() > 0);
    const first = await page.evaluate(() => window.fixture.pixels());
    await page.evaluate(() => {
        window.fixture.video.currentTime = 9;
    });
    await page.waitForFunction(() => !window.fixture.video.seeking && window.fixture.pixels() > 0);
    assert.equal(await page.evaluate(() => window.fixture.pixels()), first);
    await page.evaluate(() => {
        window.fixture.video.currentTime = 25;
    });
    await page.waitForFunction(() => !window.fixture.video.seeking && window.fixture.pixels() === 0);
    await page.evaluate(() => {
        window.fixture.video.currentTime = 0;
    });
    await page.waitForFunction(() => !window.fixture.video.seeking && window.fixture.pixels() > 0);
    console.log('PASS: paused same-cue redraw, empty interval, backward seek to zero');

    for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.fixture.text());
        await page.evaluate(() => window.fixture.select());
        assert.ok(await page.evaluate(() => window.fixture.pixels()) > 0);
    }
    await page.evaluate(() => {
        window.fixture.clear();
    });
    assert.equal(await page.locator('.subtitle-pipeline-ass').count(), 0);
    await page.evaluate(() => window.fixture.select());
    assert.ok(await page.evaluate(() => window.fixture.pixels()) > 0);
    console.log('PASS: repeated switching and off/on');

    await page.evaluate(() => {
        window.fixture.clear();
        window.cancelled = window.fixture.select(true);
    });
    await page.evaluate(() => window.fixture.clear());
    await page.evaluate(() => window.cancelled);
    assert.equal(await page.locator('.subtitle-pipeline-ass').count(), 0);
    await page.evaluate(() => window.fixture.select());
    console.log('PASS: cancelled slow load cannot restore an obsolete track');

    await page.evaluate(() => {
        window.retiredRenderer = window.fixture.renderer();
        window.retiredRenderer.worker.terminate();
        return window.fixture.video.play();
    });
    await page.waitForFunction(() => (
        window.fixture.renderer()
        && window.fixture.renderer() !== window.retiredRenderer
        && window.fixture.pixels() > 0
    ), undefined, { timeout: 15_000 });
    assert.equal(await page.locator('.subtitle-pipeline-ass').count(), 1);
    console.log('PASS: a silently stopped worker is recreated without a user seek');
    await page.evaluate(() => window.fixture.video.pause());

    await page.evaluate(() => window.fixture.select(false, false, false, 1));
    assert.equal(await page.locator('.subtitle-pipeline-ass').count(), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
        window.fixture.video.parentElement.style.width = '360px';
        window.fixture.video.parentElement.style.height = '202px';
    });
    await page.waitForFunction(() => {
        const width = document.querySelector('.subtitle-pipeline-ass canvas').width;
        return width > 0 && width <= 360 && window.fixture.pixels() > 0;
    });
    assert.ok(await page.evaluate(() => window.fixture.pixels()) > 0);
    console.log('PASS: two subtitle slots and mobile-size resize');

    await page.evaluate(() => {
        window.fixture.video.currentTime = 32;
        window.fixture.video.playbackRate = 2;
    });
    await page.waitForFunction(() => !window.fixture.video.seeking && window.fixture.pixels() > 0);
    const centroid = () => {
        const canvas = document.querySelector('.subtitle-pipeline-ass canvas');
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i]) {
                sum += ((i - 3) / 4) % canvas.width;
                count++;
            }
        }
        return sum / count;
    };
    const beforeAnimation = await page.evaluate(centroid);
    await page.evaluate(() => window.fixture.video.play());
    await page.waitForFunction(() => window.fixture.renderer().lastRenderedTime >= 34);
    await page.evaluate(() => window.fixture.video.pause());
    assert.ok(await page.evaluate(centroid) > beforeAnimation, 'ASS animation must advance at 2x playback');
    console.log('PASS: animated ASS follows 2x playback');

    await page.evaluate(() => {
        window.fixture.reset();
        window.fixture.video.currentTime = 0;
    });
    await page.evaluate(() => window.fixture.select(false, true));
    assert.ok(await page.evaluate(() => window.fixture.pixels()) > 0, 'legacy worker must also render');
    console.log('PASS: legacy libass worker');

    assert.deepEqual(errors, []);
    assert.ok(requests.includes('/slow.ass') && requests.includes('/slow-font.woff2'));
    console.log('ASS browser checks passed; no screenshots captured.');
} finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
    assert.ok(path.basename(temporary).startsWith('jellyfin-ass-test-'));
    await rm(temporary, { recursive: true, force: true });
}
/* eslint-enable compat/compat */
