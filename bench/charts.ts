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
  /** Card size in pixels; defaults to LinkedIn landscape (1200x627). */
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

const MIN_WIDTH = 880;
// Wide enough for a value label such as "100%" or "$2.14" to sit above its bar without overlap.
const MIN_BAR_WIDTH = 40;
const BASE_HEIGHT = 440;
const SHADOW = 4;
// Top margin leaves room for a value label above a full-height bar without touching the legend.
const MARGIN = { top: 124, right: 32, bottom: 64, left: 72 };
const BAR_GAP = 2;
const GROUP_PADDING = 0.28;
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

const WATERMARK_HEIGHT = 40;
const WATERMARK_PADDING = 12;
/** Extra card height reserved below the plot so the watermark never overlaps axis labels. */
const WATERMARK_BAND = WATERMARK_HEIGHT + WATERMARK_PADDING * 2;

/** Bottom-right watermark `<image>`, positioned within a reserved band at the card's bottom edge. */
function watermarkMarkup(cardWidth: number, cardHeight: number) {
  const watermark = loadWatermark();
  if (!watermark) return '';
  const height = WATERMARK_HEIGHT;
  const width = height * watermark.aspect;
  const x = cardWidth - SHADOW - WATERMARK_PADDING - width;
  const y = cardHeight - SHADOW - WATERMARK_PADDING - height;
  return `<image x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" href="${watermark.dataUri}" xlink:href="${watermark.dataUri}" preserveAspectRatio="xMidYMid meet" opacity="0.15"/>`;
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

/** Top-right watermark, next to the title, for the 1200x627 cards. */
function topWatermarkMarkup(cardWidth: number) {
  const watermark = loadWatermark();
  if (!watermark) return '';
  const height = 60;
  const width = height * watermark.aspect;
  const x = cardWidth - 36 - SHADOW - width;
  return `<image x="${x.toFixed(1)}" y="54" width="${width.toFixed(1)}" height="${height}" href="${watermark.dataUri}" xlink:href="${watermark.dataUri}" preserveAspectRatio="xMidYMid meet" opacity="0.15"/>`;
}

/** Height given to a zero bar so it still reads as "a bar that is practically zero". */
const ZERO_BAR_HEIGHT = 3;
const MAX_BAR_WIDTH = 140;
const BAR_SPACING = 4;

/**
 * Grouped bars on a fixed 1200x627 card (LinkedIn landscape) with type sized for phones.
 * Every value is direct-labeled, including zeros, so no y axis is drawn.
 */
export function groupedBarChart(chart: GroupedBarChart): string {
  const WIDTH = chart.size?.width ?? LINKEDIN_WIDTH;
  const HEIGHT = chart.size?.height ?? LINKEDIN_HEIGHT;
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

// ---------- LinkedIn cards (fixed 1200x627 landscape, larger type for phone-size viewing) ----------

const LINKEDIN_WIDTH = 1200;
const LINKEDIN_HEIGHT = 627;

export type SummaryPanelItem = { name: string; color: string; value: number | null };

export type SummaryChartOptions = {
  headline: string;
  subtitle: string;
  accuracy: SummaryPanelItem[];
  cost: SummaryPanelItem[];
  costFormat: (value: number) => string;
};

/** Two-panel LinkedIn card: accuracy (%) on the left, total cost (USD) on the right. No dual axis. */
export function summaryChart(chart: SummaryChartOptions): string {
  const watermark = loadWatermark();
  const outerMargin = 48;
  const panelTop = 156;
  const bottomReserve = 56 + (watermark ? WATERMARK_BAND : 0);
  const plotBottom = LINKEDIN_HEIGHT - SHADOW - bottomReserve;
  const plotTop = panelTop + 56;
  const plotHeight = plotBottom - plotTop;
  const gap = 48;
  const panelWidth = (LINKEDIN_WIDTH - SHADOW - outerMargin * 2 - gap) / 2;
  const leftX = outerMargin;
  const rightX = outerMargin + panelWidth + gap;
  const barGap = 24;

  function panel(x: number, title: string, items: SummaryPanelItem[], format: (v: number) => string, max: number) {
    const n = items.length;
    const barWidth = Math.min(90, (panelWidth - barGap * (n - 1)) / n);
    const totalWidth = barWidth * n + barGap * (n - 1);
    const startX = x + (panelWidth - totalWidth) / 2;
    const bars = items
      .map((item, i) => {
        const bx = startX + i * (barWidth + barGap);
        const center = (bx + barWidth / 2).toFixed(1);
        if (item.value === null) {
          return `<text x="${center}" y="${(plotBottom - 8).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="${COLORS.muted}">N/A</text>`;
        }
        const height = Math.max((item.value / max) * plotHeight, 0);
        const top = plotBottom - height;
        return [
          `<g><title>${escapeXml(`${item.name}: ${format(item.value)}`)}</title>`,
          `<path d="${barPath(bx, top, barWidth, height)}" fill="${item.color}" stroke="${COLORS.ink}" stroke-width="2" stroke-linejoin="round"/>`,
          `<text x="${center}" y="${(top - 12).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="20" font-weight="700" fill="${COLORS.ink}">${escapeXml(format(item.value))}</text>`,
          `<text x="${center}" y="${(plotBottom + 28).toFixed(1)}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLORS.heading}">${escapeXml(item.name)}</text>`,
          '</g>',
        ].join('');
      })
      .join('\n');
    return [
      `<text x="${x}" y="${panelTop}" font-family="${SANS}" font-size="20" font-weight="700" fill="${COLORS.heading}">${escapeXml(title)}</text>`,
      `<line x1="${x}" x2="${x + panelWidth}" y1="${plotBottom}" y2="${plotBottom}" stroke="${COLORS.grid}" stroke-width="2"/>`,
      bars,
    ].join('\n');
  }

  const costMax = niceMax(Math.max(0, ...chart.cost.map((item) => item.value ?? 0)));
  const leftPanel = panel(leftX, 'Accuracy (all questions)', chart.accuracy, (v) => `${Math.round(v)}%`, 100);
  const rightPanel = panel(rightX, 'Total cost (USD)', chart.cost, chart.costFormat, costMax);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${LINKEDIN_WIDTH}" height="${LINKEDIN_HEIGHT}" viewBox="0 0 ${LINKEDIN_WIDTH} ${LINKEDIN_HEIGHT}" role="img" aria-label="${escapeXml(chart.headline)}">
<rect x="${SHADOW}" y="${SHADOW}" width="${LINKEDIN_WIDTH - SHADOW - 1}" height="${LINKEDIN_HEIGHT - SHADOW - 1}" rx="12" fill="${COLORS.ink}"/>
<rect x="1" y="1" width="${LINKEDIN_WIDTH - SHADOW - 2}" height="${LINKEDIN_HEIGHT - SHADOW - 2}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.ink}" stroke-width="2"/>
<text x="${outerMargin}" y="56" font-family="${SANS}" font-size="28" font-weight="800" fill="${COLORS.heading}">${escapeXml(chart.headline)}</text>
<text x="${outerMargin}" y="84" font-family="${SANS}" font-size="18" fill="${COLORS.muted}">${escapeXml(chart.subtitle)}</text>
${leftPanel}
${rightPanel}
${watermarkMarkup(LINKEDIN_WIDTH, LINKEDIN_HEIGHT)}
</svg>
`;
}

export type LinkedinAccuracyChart = { title: string; subtitle?: string; groups: string[]; series: Series[] };

/** LinkedIn-size accuracy card: "All" plus a handful of categories, whole percents, big labels. */
export function linkedinAccuracyChart(chart: LinkedinAccuracyChart): string {
  const watermark = loadWatermark();
  const margin = { top: 150, right: 40, bottom: 90 + (watermark ? WATERMARK_BAND : 0), left: 40 };
  const plotWidth = LINKEDIN_WIDTH - SHADOW - margin.left - margin.right;
  const plotHeight = LINKEDIN_HEIGHT - SHADOW - margin.top - margin.bottom;
  const baseline = margin.top + plotHeight;
  const groupWidth = plotWidth / chart.groups.length;
  const innerWidth = groupWidth * (1 - GROUP_PADDING);
  const barWidth = (innerWidth - BAR_GAP * (chart.series.length - 1)) / chart.series.length;
  const max = 100;
  const y = (value: number) => baseline - (value / max) * plotHeight;

  const bars = chart.groups
    .map((group, groupIndex) => {
      const groupX = margin.left + groupIndex * groupWidth + (groupWidth - innerWidth) / 2;
      const marks = chart.series
        .map((series, seriesIndex) => {
          const x = groupX + seriesIndex * (barWidth + BAR_GAP);
          const value = series.values[groupIndex];
          const center = (x + barWidth / 2).toFixed(1);
          if (value === null || value === undefined) {
            return `<text x="${center}" y="${baseline - 8}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="${COLORS.muted}">N/A</text>`;
          }
          const top = y(value);
          const height = Math.max(baseline - top, 0);
          const label = `${Math.round(value)}%`;
          return [
            `<g><title>${escapeXml(`${series.name} · ${group}: ${label}`)}</title>`,
            `<path d="${barPath(x, top, barWidth, height)}" fill="${series.color}" stroke="${COLORS.ink}" stroke-width="2" stroke-linejoin="round"/>`,
            `<text x="${center}" y="${(top - 10).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="20" font-weight="700" fill="${COLORS.ink}">${escapeXml(label)}</text>`,
            '</g>',
          ].join('');
        })
        .join('\n');
      const labelX = (groupX + innerWidth / 2).toFixed(1);
      return `${marks}\n<text x="${labelX}" y="${baseline + 32}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLORS.heading}">${escapeXml(group)}</text>`;
    })
    .join('\n');

  const legend = chart.series
    .map((series, index) => {
      const x = margin.left + index * 220;
      return [
        `<rect x="${x}" y="96" width="18" height="18" rx="3" fill="${series.color}" stroke="${COLORS.ink}" stroke-width="2"/>`,
        `<text x="${x + 26}" y="105" dy="0.32em" font-family="${SANS}" font-size="18" font-weight="600" fill="${COLORS.heading}">${escapeXml(series.name)}</text>`,
      ].join('');
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${LINKEDIN_WIDTH}" height="${LINKEDIN_HEIGHT}" viewBox="0 0 ${LINKEDIN_WIDTH} ${LINKEDIN_HEIGHT}" role="img" aria-label="${escapeXml(chart.title)}">
<rect x="${SHADOW}" y="${SHADOW}" width="${LINKEDIN_WIDTH - SHADOW - 1}" height="${LINKEDIN_HEIGHT - SHADOW - 1}" rx="12" fill="${COLORS.ink}"/>
<rect x="1" y="1" width="${LINKEDIN_WIDTH - SHADOW - 2}" height="${LINKEDIN_HEIGHT - SHADOW - 2}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.ink}" stroke-width="2"/>
<text x="40" y="44" font-family="${SANS}" font-size="28" font-weight="800" fill="${COLORS.heading}">${escapeXml(chart.title)}</text>
${chart.subtitle ? `<text x="40" y="70" font-family="${SANS}" font-size="18" fill="${COLORS.muted}">${escapeXml(chart.subtitle)}</text>` : ''}
${legend}
${bars}
${watermarkMarkup(LINKEDIN_WIDTH, LINKEDIN_HEIGHT)}
</svg>
`;
}
