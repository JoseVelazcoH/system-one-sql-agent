const MODES = [
  { key: 'jev', label: 'Con JEV' },
  { key: 'standard', label: 'Estándar' },
];
const VERDICTS = {
  correct: 'correcta',
  incorrect: 'incorrecta',
  review: 'revisar',
  failed: 'falló',
};
const POLL_MS = 3000;

const startForm = document.querySelector('#start-form');
const startButton = startForm.querySelector('button');
const status = document.querySelector('#status');
const runSelect = document.querySelector('#run-select');

const getJson = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
};

function cellsRow(tag, cells) {
  const row = document.createElement('tr');
  for (const value of cells) {
    const cell = document.createElement(tag);
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

const PNG_SCALE = 2;

async function downloadPng(svgUrl, fileName) {
  const image = new Image();
  image.src = svgUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth * PNG_SCALE;
  canvas.height = image.naturalHeight * PNG_SCALE;
  const context = canvas.getContext('2d');
  context.scale(PNG_SCALE, PNG_SCALE);
  context.drawImage(image, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderSummary(name, summary) {
  document.querySelector('#run-meta').textContent = `Modelo ${summary.model ?? '–'} · ${name}`;

  document.querySelector('#charts').replaceChildren(
    ...summary.charts.map((path) => {
      const chartName = path.split('/').pop().replace('.svg', '');
      const figure = document.createElement('figure');
      figure.className = 'bench-chart';
      const image = document.createElement('img');
      image.src = `/bench-results/${path}?v=${name}`;
      image.alt = chartName;
      image.loading = 'lazy';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bench-controls__button bench-controls__button--secondary bench-chart__export';
      button.textContent = 'PNG';
      button.setAttribute('aria-label', `Descargar ${chartName} como PNG`);
      button.addEventListener('click', () => downloadPng(image.src, `${name}-${chartName}.png`));
      figure.append(image, button);
      return figure;
    }),
  );

  document.querySelector('#metrics').replaceChildren(
    cellsRow('th', ['Métrica', ...MODES.map((mode) => mode.label)]),
    ...summary.metrics.map((metric) =>
      cellsRow('td', [metric.label, ...MODES.map((mode) => String(metric.values[mode.key] ?? '–'))]),
    ),
  );

  const runCell = (run) =>
    run
      ? `${VERDICTS[run.verdict] ?? run.verdict} · ${run.durationMs === null ? '–' : `${(run.durationMs / 1000).toFixed(1)} s`} · ${run.tokens.toLocaleString('es-ES')} tok`
      : '–';
  document.querySelector('#questions').replaceChildren(
    cellsRow('th', ['#', 'Pregunta', 'Categoría', 'Con datos', ...MODES.map((mode) => mode.label)]),
    ...summary.questions.map((question) => {
      const row = cellsRow('td', [
        question.id,
        question.question ?? '',
        question.category,
        question.answerable ? 'sí' : 'no',
        ...MODES.map((mode) => runCell(question.runs[mode.key])),
      ]);
      MODES.forEach((mode, index) => {
        const verdict = question.runs[mode.key]?.verdict;
        if (verdict) row.children[4 + index].dataset.verdict = verdict;
      });
      return row;
    }),
  );
}

async function loadRuns(selected) {
  const runs = await getJson('/api/bench/runs');
  runSelect.replaceChildren(
    ...runs.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name.replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2:$3 UTC');
      return option;
    }),
  );
  const name = selected && runs.includes(selected) ? selected : runs[0];
  if (!name) {
    document.querySelector('#run-meta').textContent = 'Todavía no hay corridas calificadas';
    return;
  }
  runSelect.value = name;
  renderSummary(name, await getJson(`/api/bench/runs/${name}`));
}

const PHASES = { running: 'Ejecutando', grading: 'Calificando', done: 'Terminado', error: 'Error' };

async function pollStatus() {
  const job = await getJson('/api/bench/status').catch(() => null);
  const active = job && (job.phase === 'running' || job.phase === 'grading');
  startButton.disabled = Boolean(active);
  if (!job) return;

  status.textContent =
    job.phase === 'error'
      ? `Error: ${job.error}`
      : `${PHASES[job.phase]} · ${Math.min(job.done, job.total)}/${job.total} corridas`;

  if (active) {
    setTimeout(pollStatus, POLL_MS);
  } else if (job.phase === 'done' && runSelect.value !== job.name) {
    await loadRuns(job.name);
  }
}

startForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  startButton.disabled = true;
  try {
    await getJson('/api/bench/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: Number(document.querySelector('#limit').value) }),
    });
    pollStatus();
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    startButton.disabled = false;
  }
});

runSelect.addEventListener('change', async () => {
  renderSummary(runSelect.value, await getJson(`/api/bench/runs/${runSelect.value}`));
});

document.querySelector('#export-pdf').addEventListener('click', () => {
  const previousTitle = document.title;
  document.title = `benchmark-${runSelect.value || 'jev'}`; // default PDF file name
  window.print();
  document.title = previousTitle;
});

loadRuns();
pollStatus();
