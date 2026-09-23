const AGENTS = [
  {
    mode: 'jev',
    title: 'Agente con JEV',
    subtitle: 'Modelo de decisión habilitado',
    badge: (model) => `${model} + JEV`,
  },
  {
    mode: 'standard',
    title: 'Agente estándar',
    subtitle: 'Sin modelo de decisión',
    badge: (model) => `${model} estándar`,
  },
];

const STATUS_LABELS = {
  idle: 'En espera',
  running: 'Procesando',
  done: 'Completado',
  error: 'Error',
};

const number = (value, digits) =>
  value.toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const form = document.querySelector('#ask-form');
const input = document.querySelector('#question');
const sendButton = form.querySelector('button');
const grid = document.querySelector('.grid');
const template = document.querySelector('#card-template');

const cards = Object.fromEntries(
  AGENTS.map((agent) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.mode = agent.mode;
    node.querySelector('.card__title').textContent = agent.title;
    node.querySelector('.card__subtitle').textContent = agent.subtitle;
    node.querySelector('.model-badge').textContent = agent.badge('—');
    grid.append(node);
    return [agent.mode, { agent, node, find: (selector) => node.querySelector(selector) }];
  }),
);

function setStatus(card, state) {
  const status = card.find('.status');
  status.dataset.state = state;
  status.textContent = STATUS_LABELS[state];
}

function setResponse(card, text, empty = false) {
  const response = card.find('.response');
  response.textContent = text;
  response.toggleAttribute('data-empty', empty);
}

function resetCard(card, question) {
  setStatus(card, 'running');
  card.find('.block--user').hidden = false;
  card.find('.user-prompt').textContent = question;
  card.find('.meta-pill').hidden = true;
  card.find('.block--queries').hidden = true;
  setResponse(card, 'Consultando…', true);
  card.find('.metrics__seconds').textContent = '–';
  card.find('.metrics__stages').textContent = '–';
  card.find('.metrics__count').textContent = '– tokens';
  card.find('.metrics__split').textContent = 'entrada – · salida –';
}

function renderRoute(card, route) {
  const pill = card.find('.meta-pill');
  if (!route) return;
  pill.hidden = false;
  card.find('.meta-pill__databases').textContent = route.length
    ? `bases: ${route.map((match) => match.database).join(', ')}`
    : 'bases: ninguna';
  const best = route[0]?.probability;
  card.find('.meta-pill__confidence').textContent =
    best === undefined ? 'confianza –' : `confianza ${number(best, 2)}`;
}

function renderQueries(card, queries) {
  const list = card.find('.queries');
  list.replaceChildren(
    ...queries.map((query) => {
      const item = document.createElement('li');
      item.className = 'query';
      item.toggleAttribute('data-failed', Boolean(query.error));

      const meta = document.createElement('div');
      meta.className = 'query__meta';
      const database = document.createElement('span');
      database.className = 'query__database';
      database.textContent = query.database;
      const result = document.createElement('span');
      result.className = 'query__result';
      result.textContent = query.error
        ? `error: ${query.error}`
        : `${query.rowCount.toLocaleString('es-ES')} filas`;
      meta.append(database, result);

      const sql = document.createElement('pre');
      sql.className = 'query__sql';
      sql.textContent = query.sql.trim();

      item.append(meta, sql);
      return item;
    }),
  );
  card.find('.block--queries').hidden = queries.length === 0;
}

function renderRun(card, run) {
  const seconds = run.durationMs / 1000;
  setStatus(card, 'done');
  card.find('.model-badge').textContent = card.agent.badge(run.model);
  renderRoute(card, run.route);
  setResponse(card, run.text);
  renderQueries(card, run.queries);
  card.find('.metrics__seconds').textContent = number(seconds, 2);
  card.find('.metrics__stages').textContent = describeStages(run.timings);
  card.find('.metrics__count').textContent =
    `${integer(run.inputTokens + run.outputTokens)} tokens`;
  card.find('.metrics__split').textContent =
    `entrada ${integer(run.inputTokens)} · salida ${integer(run.outputTokens)}`;
}

const integer = (value) =>
  Math.round(value).toLocaleString('es-ES', { useGrouping: 'always' });

function describeStages(timings) {
  const stage = (label, ms) => (ms === undefined ? null : `${label} ${number(ms / 1000, 1)} s`);
  return [
    stage('bases', timings.routeMs),
    stage('tablas', timings.tablesMs),
    stage('ejecutor', timings.executorMs),
  ]
    .filter(Boolean)
    .join(' · ');
}

async function runCard(card, question) {
  resetCard(card, question);
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, mode: card.agent.mode }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    renderRun(card, body);
  } catch (error) {
    setStatus(card, 'error');
    setResponse(card, error.message, true);
  }
}

for (const card of Object.values(cards)) {
  setStatus(card, 'idle');
  setResponse(card, 'Envía una consulta para comparar ambos agentes.', true);
}

fetch('/api/config')
  .then((response) => response.json())
  .then(({ model }) => {
    for (const card of Object.values(cards)) {
      card.find('.model-badge').textContent = card.agent.badge(model);
    }
  })
  .catch(() => {});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = input.value.trim();
  if (!question) return;
  sendButton.disabled = true;
  // Both agents run in parallel so their timings are comparable.
  await Promise.all(Object.values(cards).map((card) => runCard(card, question)));
  sendButton.disabled = false;
});

// Allows shareable links such as /?q=... that run the comparison on load.
const initialQuestion = new URLSearchParams(location.search).get('q');
if (initialQuestion) {
  input.value = initialQuestion;
  form.requestSubmit();
}
