/**
 * Dependency-free SVG grouped bar charts in the repo's visual language
 * (see public/styles.css): 2px ink borders, hard shadow, Inter + JetBrains Mono.
 */

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

const WIDTH = 880;
const HEIGHT = 440;
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

export function groupedBarChart(chart: GroupedBarChart): string {
  const values = chart.series.flatMap((series) => series.values).filter((v): v is number => v !== null);
  const max = chart.max ?? niceMax(Math.max(0, ...values));
  const plotWidth = WIDTH - SHADOW - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - SHADOW - MARGIN.top - MARGIN.bottom;
  const baseline = MARGIN.top + plotHeight;
  const groupWidth = plotWidth / chart.groups.length;
  const innerWidth = groupWidth * (1 - GROUP_PADDING);
  const barWidth = (innerWidth - BAR_GAP * (chart.series.length - 1)) / chart.series.length;
  const y = (value: number) => baseline - (value / max) * plotHeight;

  // toPrecision drops float noise such as 0.6000000000000001.
  const ticks = Array.from({ length: 6 }, (_, i) => Number(((max / 5) * i).toPrecision(6)));
  const grid = ticks
    .map((tick) => {
      const ty = y(tick).toFixed(1);
      return [
        `<line x1="${MARGIN.left}" x2="${MARGIN.left + plotWidth}" y1="${ty}" y2="${ty}" stroke="${COLORS.grid}" stroke-width="1" ${tick === 0 ? '' : 'stroke-dasharray="3 4"'}/>`,
        `<text x="${MARGIN.left - 10}" y="${ty}" dy="0.32em" text-anchor="end" font-family="${MONO}" font-size="11" fill="${COLORS.muted}">${escapeXml((chart.tickFormat ?? chart.format)(tick))}</text>`,
      ].join('');
    })
    .join('\n');

  const bars = chart.groups
    .map((group, groupIndex) => {
      const groupX = MARGIN.left + groupIndex * groupWidth + (groupWidth - innerWidth) / 2;
      const marks = chart.series
        .map((series, seriesIndex) => {
          const x = groupX + seriesIndex * (barWidth + BAR_GAP);
          const value = series.values[groupIndex];
          const center = (x + barWidth / 2).toFixed(1);
          if (value === null || value === undefined) {
            return `<text x="${center}" y="${baseline - 8}" text-anchor="middle" font-family="${MONO}" font-size="11" fill="${COLORS.muted}">N/A</text>`;
          }
          const top = y(value);
          const height = Math.max(baseline - top, 0);
          const label = chart.format(value);
          return [
            `<g><title>${escapeXml(`${series.name} · ${group}: ${label}`)}</title>`,
            `<path d="${barPath(x, top, barWidth, height)}" fill="${series.color}" stroke="${COLORS.ink}" stroke-width="2" stroke-linejoin="round"/>`,
            `<text x="${center}" y="${(top - 8).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="11" font-weight="600" fill="${COLORS.ink}">${escapeXml(label)}</text>`,
            '</g>',
          ].join('');
        })
        .join('\n');
      const labelX = (groupX + innerWidth / 2).toFixed(1);
      return `${marks}\n<text x="${labelX}" y="${baseline + 24}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${COLORS.heading}">${escapeXml(group)}</text>`;
    })
    .join('\n');

  const legend = chart.series
    .map((series, index) => {
      const x = MARGIN.left + index * 150;
      return [
        `<rect x="${x}" y="72" width="14" height="14" rx="3" fill="${series.color}" stroke="${COLORS.ink}" stroke-width="2"/>`,
        `<text x="${x + 22}" y="79" dy="0.32em" font-family="${SANS}" font-size="12" font-weight="600" fill="${COLORS.heading}">${escapeXml(series.name)}</text>`,
      ].join('');
    })
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(chart.title)}">
<rect x="${SHADOW}" y="${SHADOW}" width="${WIDTH - SHADOW - 1}" height="${HEIGHT - SHADOW - 1}" rx="12" fill="${COLORS.ink}"/>
<rect x="1" y="1" width="${WIDTH - SHADOW - 2}" height="${HEIGHT - SHADOW - 2}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.ink}" stroke-width="2"/>
<text x="${MARGIN.left - 48}" y="36" font-family="${SANS}" font-size="16" font-weight="600" fill="${COLORS.heading}">${escapeXml(chart.title)}</text>
${chart.subtitle ? `<text x="${MARGIN.left - 48}" y="56" font-family="${SANS}" font-size="12" fill="${COLORS.muted}">${escapeXml(chart.subtitle)}</text>` : ''}
${legend}
${grid}
${bars}
</svg>
`;
}
