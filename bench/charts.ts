/**
 * Dependency-free SVG grouped bar charts in the repo's visual language
 * (see public/styles.css): 2px ink borders, hard shadow, Inter + JetBrains Mono.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

export type Series = { name: string; color: string; values: (number | null)[] };

export type GroupedBarChart = {
  title: string;
  subtitle?: string;
  groups: string[];
  series: Series[];
  format: (value: number) => string;
  /** Axis tick labels; defaults to `format`. */
  tickFormat?: (value: number) => string;
  /** Fixed axis maximum, e.g. 100 for percentages. Defaults to a nice value above the data. */
  max?: number;
  /** Card size in pixels; defaults to 1200x627. */
  size?: { width: number; height: number };
};

// Same tokens as public/styles.css. Series colors were checked with the dataviz validator:
// CVD separation passes; the orange sits below 3:1 on white, so bars carry an ink border
// and every bar is direct-labeled.
export const COLORS = {
  jev: '#ff8e3c',
  standard: '#d9376e',
  ink: '#0d0d0d',
  surface: '#eff0f3',
  panel: '#ffffff',
  heading: '#171717',
  muted: '#737373',
  grid: '#d4d4d8',
};

const CORNER = 4;
const SANS = "Inter, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

// ---------- watermark ----------

type WatermarkInfo = { dataUri: string; aspect: number };

let cachedWatermark: WatermarkInfo | null | undefined;

/** Reads `benchmark.watermark` from config.yaml once and caches the base64 data URI. */
function loadWatermark(): WatermarkInfo | null {
  if (cachedWatermark !== undefined) return cachedWatermark;
  const url = config.benchmark.watermarkPath;
  if (!url) return (cachedWatermark = null);
  try {
    const path = fileURLToPath(url);
    const buffer = readFileSync(path);
    const isSvg = path.toLowerCase().endsWith('.svg');
    const mime = isSvg ? 'image/svg+xml' : 'image/png';
    let aspect = 1;
    if (isSvg) {
      const text = buffer.toString('utf8');
      const viewBox = text.match(/viewBox="[\d.\s-]+\s+[\d.\s-]+\s+([\d.]+)\s+([\d.]+)"/);
      const widthAttr = text.match(/width="([\d.]+)"/);
      const heightAttr = text.match(/height="([\d.]+)"/);
      if (viewBox) aspect = Number(viewBox[1]) / Number(viewBox[2]);
      else if (widthAttr && heightAttr) aspect = Number(widthAttr[1]) / Number(heightAttr[1]);
    } else if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
      // IHDR chunk: width at byte 16, height at byte 20, both big-endian uint32.
      aspect = buffer.readUInt32BE(16) / buffer.readUInt32BE(20);
    }
    return (cachedWatermark = { dataUri: `data:${mime};base64,${buffer.toString('base64')}`, aspect });
  } catch {
    return (cachedWatermark = null);
  }
}


/** Smallest 1/2/2.5/5 x 10^n step that gives about five ticks. */
function niceMax(value: number) {
  if (value <= 0) return 1;
  const rough = value / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough)!;
  return Math.ceil(value / step) * step;
}

/** Bar with rounded top corners and a square base anchored on the baseline. */
function barPath(x: number, y: number, width: number, height: number) {
  const r = Math.min(CORNER, width / 2, height);
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${y + height}`,
    'Z',
  ].join(' ');
}

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 627;

/** Top-right watermark, next to the title. */
function topWatermarkMarkup(cardWidth: number) {
  const watermark = loadWatermark();
  if (!watermark) return '';
  const height = 60;
  const width = height * watermark.aspect;
  const x = cardWidth - 40 - width;
  return `<image x="${x.toFixed(1)}" y="54" width="${width.toFixed(1)}" height="${height}" href="${watermark.dataUri}" xlink:href="${watermark.dataUri}" preserveAspectRatio="xMidYMid meet" opacity="0.15"/>`;
}

/** Height given to a zero bar so it still reads as "a bar that is practically zero". */
const ZERO_BAR_HEIGHT = 3;
const MAX_BAR_WIDTH = 140;
const BAR_SPACING = 4;

/**
 * Grouped bars on a card (1200x627 by default) with type sized for phones.
 * Every value is direct-labeled, including zeros, so no y axis is drawn.
 */
export function groupedBarChart(chart: GroupedBarChart): string {
  const WIDTH = chart.size?.width ?? DEFAULT_WIDTH;
  const HEIGHT = chart.size?.height ?? DEFAULT_HEIGHT;
  const plot = { left: 70, right: 60, top: 215, bottom: 110 };
  const values = chart.series.flatMap((series) => series.values).filter((v): v is number => v !== null);
  const max = chart.max ?? niceMax(Math.max(0, ...values));
  const plotWidth = WIDTH - plot.left - plot.right;
  const plotHeight = HEIGHT - plot.top - plot.bottom;
  const baseline = plot.top + plotHeight;
  const groupWidth = plotWidth / chart.groups.length;
  // Bars are capped so a chart with one group does not turn into three wide slabs.
  const barWidth = Math.min((groupWidth * 0.8) / chart.series.length, MAX_BAR_WIDTH);
  const innerWidth = barWidth * chart.series.length;
  // Shrink value labels until the longest one (e.g. "100%") fits within its bar.
  const longestLabel = Math.max(...values.map((value) => chart.format(value).length), 1);
  const valueSize = Math.min(chart.groups.length > 4 ? 16 : 22, (barWidth - 4) / (longestLabel * 0.62));
  const groupSize = chart.groups.length > 6 ? 18 : 22;

  const bars = chart.groups
    .map((group, groupIndex) => {
      const groupX = plot.left + groupIndex * groupWidth + (groupWidth - innerWidth) / 2;
      const marks = chart.series
        .map((series, seriesIndex) => {
          const x = groupX + seriesIndex * barWidth;
          const center = (x + (barWidth - BAR_SPACING) / 2).toFixed(1);
          const value = series.values[groupIndex];
          if (value === null || value === undefined) {
            return `<text x="${center}" y="${baseline - 10}" text-anchor="middle" font-family="${MONO}" font-size="${valueSize}" fill="${COLORS.muted}">N/A</text>`;
          }
          const height = Math.max((value / max) * plotHeight, ZERO_BAR_HEIGHT);
          const top = baseline - height;
          const label = chart.format(value);
          return [
            `<g><title>${escapeXml(`${series.name} · ${group}: ${label}`)}</title>`,
            `<path d="${barPath(x, top, barWidth - BAR_SPACING, height)}" fill="${series.color}" stroke="${COLORS.ink}" stroke-width="2" stroke-linejoin="round"/>`,
            `<text x="${center}" y="${(top - 8).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="${valueSize}" font-weight="700" fill="${COLORS.ink}">${escapeXml(label)}</text>`,
            '</g>',
          ].join('');
        })
        .join('\n');
      const labelX = (groupX + innerWidth / 2).toFixed(1);
      return `${marks}\n<text x="${labelX}" y="${baseline + 34}" text-anchor="middle" font-family="${SANS}" font-size="${groupSize}" font-weight="600" fill="${COLORS.heading}">${escapeXml(group)}</text>`;
    })
    .join('\n');

  const legend = chart.series
    .map((series, index) => {
      const x = 64 + index * 230;
      return [
        `<rect x="${x}" y="158" width="22" height="22" rx="4" fill="${series.color}" stroke="${COLORS.ink}" stroke-width="2.5"/>`,
        `<text x="${x + 32}" y="176" font-family="${SANS}" font-size="22" font-weight="600" fill="${COLORS.heading}">${escapeXml(series.name)}</text>`,
      ].join('');
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(chart.title)}">
<rect width="${WIDTH}" height="${HEIGHT}" fill="${COLORS.panel}"/>
<rect x="30" y="30" width="${WIDTH - 54}" height="${HEIGHT - 54}" rx="16" fill="${COLORS.ink}"/>
<rect x="24" y="24" width="${WIDTH - 54}" height="${HEIGHT - 54}" rx="16" fill="${COLORS.panel}" stroke="${COLORS.ink}" stroke-width="3"/>
<text x="64" y="92" font-family="${SANS}" font-size="36" font-weight="700" fill="${COLORS.heading}">${escapeXml(chart.title)}</text>
${chart.subtitle ? `<text x="64" y="130" font-family="${SANS}" font-size="22" fill="${COLORS.muted}">${escapeXml(chart.subtitle)}</text>` : ''}
${legend}
<line x1="${plot.left}" x2="${WIDTH - plot.right}" y1="${baseline}" y2="${baseline}" stroke="${COLORS.grid}" stroke-width="2"/>
${bars}
${topWatermarkMarkup(WIDTH)}
</svg>
`;
}
