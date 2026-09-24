/**
 * Renders every .svg file in a folder to a .png at 2x using headless Chrome/Chromium.
 *
 *   pnpm bench:png -- <charts dir>
 *
 * Each SVG is wrapped in a minimal HTML page sized to the SVG's own width/height (read from
 * its attributes), so the screenshot captures exactly the chart with no extra whitespace.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WINDOW_PADDING = 200;

const BROWSERS = ['google-chrome', 'chromium', 'chromium-browser'];
const SCALE = 2;

async function findBrowser(): Promise<string | null> {
  for (const name of BROWSERS) {
    try {
      await run(name, ['--version']);
      return name;
    } catch {
      // Not on PATH, or not runnable; try the next candidate.
    }
  }
  return null;
}

/** Reads width/height straight off the <svg> tag; falls back to a generous default. */
function svgDimensions(svg: string) {
  const width = Number(svg.match(/<svg[^>]*\swidth="([\d.]+)"/)?.[1] ?? 1200);
  const height = Number(svg.match(/<svg[^>]*\sheight="([\d.]+)"/)?.[1] ?? 630);
  return { width, height };
}

async function renderOne(browser: string, dir: string, file: string) {
  const svgPath = join(dir, file);
  const svg = await readFile(svgPath, 'utf8');
  const { width, height } = svgDimensions(svg);
  const pngPath = join(dir, file.replace(/\.svg$/, '.png'));
  const scaledWidth = Math.round(width * SCALE);
  const scaledHeight = Math.round(height * SCALE);
  // Scale by overriding the <svg> tag's own width/height (viewBox stays put), so the browser
  // does true vector upscaling. --force-device-scale-factor combined with --window-size is
  // unreliable here: Chrome headless treats --window-size as CSS pixels even under a device
  // scale factor, which silently clips the page instead of rendering it larger.
  const scaledSvg = svg.replace(
    /<svg([^>]*)\swidth="[\d.]+"([^>]*)\sheight="[\d.]+"/,
    `<svg$1 width="${scaledWidth}"$2 height="${scaledHeight}"`,
  );

  const workDir = await mkdtemp(join(tmpdir(), 'bench-png-'));
  const htmlPath = join(workDir, 'page.html');
  try {
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;}
svg{display:block;}
</style></head><body>${scaledSvg}</body></html>`;
    await writeFile(htmlPath, html);
    await run(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      // Headless Chrome reserves ~90px of the window height for browser UI, which cut off the
      // bottom of every chart. Render into a taller window and crop back to the chart size.
      `--window-size=${scaledWidth},${scaledHeight + WINDOW_PADDING}`,
      `--screenshot=${resolve(pngPath)}`,
      pathToFileUrl(htmlPath),
    ]);
    await run('magick', [pngPath, '-crop', `${scaledWidth}x${scaledHeight}+0+0`, '+repage', pngPath]);
    console.log(`Wrote ${pngPath}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function pathToFileUrl(path: string) {
  return `file://${resolve(path)}`;
}

async function main() {
  const dir = process.argv.slice(2).filter((arg) => arg !== '--')[0];
  if (!dir) {
    console.error('Usage: pnpm bench:png -- <charts dir>');
    process.exitCode = 1;
    return;
  }
  const browser = await findBrowser();
  if (!browser) {
    console.error(
      'No headless Chrome/Chromium found on PATH (looked for google-chrome, chromium, chromium-browser). ' +
        'Install one of them to export PNGs.',
    );
    process.exitCode = 1;
    return;
  }

  const files = (await readdir(dir)).filter((name) => name.endsWith('.svg'));
  if (files.length === 0) {
    console.log(`No .svg files found in ${dir}`);
    return;
  }
  for (const file of files) {
    await renderOne(browser, dir, file);
  }
}

await main();
