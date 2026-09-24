import { experimental_evaluate as evaluate } from 'ai';
import { config } from './config.js';
import type { ExecutedQuery } from './executor.js';
import { jevUsage, NO_JEV_USAGE, type JevUsage } from './router.js';

export type SelectorCandidate = {
  text: string;
  queries: ExecutedQuery[];
};

export type SelectionResult = {
  index: number;
  probabilities: number[];
  consensus: boolean;
  usage: JevUsage;
};

/** Every plausible reading of each number in the text (1,234.5 vs 1.234,5). */
function extractNumbers(text: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(/-?\d(?:[\d.,]*\d)?/g)) {
    const token = match[0];
    const readings = [Number(token.replace(/,/g, '')), Number(token.replace(/\./g, '').replace(',', '.'))];
    for (const reading of readings) {
      if (!Number.isNaN(reading)) numbers.push(reading);
    }
  }
  return numbers;
}

/** Rounds to `digits` significant digits, e.g. sigRound(123456, 3) === 123000. */
function sigRound(value: number, digits = 3): number {
  if (value === 0) return 0;
  const magnitude = Math.ceil(Math.log10(Math.abs(value)));
  const factor = 10 ** (digits - magnitude);
  return Math.round(value * factor) / factor;
}

/** Canonical key for a candidate's numeric content: its 3 largest numbers, rounded. */
function candidateKey(candidate: SelectorCandidate): string {
  const succeeded = candidate.queries.some((query) => !query.error);
  const numbers = extractNumbers(candidate.text);
  if (numbers.length === 0 && !succeeded) return 'no-data';
  const top3 = [...numbers]
    .sort((a, b) => Math.abs(b) - Math.abs(a))
    .slice(0, 3)
    .map((n) => sigRound(n))
    .sort((a, b) => a - b);
  return JSON.stringify(top3);
}

/** Strict majority: more than half of the candidates share the same numeric content. */
function findConsensus(candidates: SelectorCandidate[]): number | null {
  const majorityThreshold = Math.floor(candidates.length / 2) + 1;
  const groups = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const key = candidateKey(candidate);
    const indices = groups.get(key) ?? [];
    indices.push(index);
    groups.set(key, indices);
  });
  for (const indices of groups.values()) {
    if (indices.length >= majorityThreshold) return indices[0];
  }
  return null;
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function describeCandidate(candidate: SelectorCandidate) {
  const lastSuccessful = [...candidate.queries].reverse().find((query) => !query.error);
  return {
    answer: candidate.text,
    finalSql: lastSuccessful?.sql ?? null,
    previewRows: lastSuccessful?.preview ?? [],
  };
}

/**
 * Picks one of N candidate answers to a question.
 * Consensus first (free, no Jev call): a strict majority of candidates agreeing on the same
 * main numbers (or all agreeing there is no data) wins outright. Otherwise Jev picks among
 * the candidates, shuffled so label order carries no information.
 */
export async function pickCandidate(
  question: string,
  candidates: SelectorCandidate[],
): Promise<SelectionResult> {
  if (candidates.length === 1) {
    return { index: 0, probabilities: [1], consensus: true, usage: NO_JEV_USAGE };
  }

  const consensusIndex = findConsensus(candidates);
  if (consensusIndex !== null) {
    const probabilities = candidates.map((_, index) => (index === consensusIndex ? 1 : 0));
    return { index: consensusIndex, probabilities, consensus: true, usage: NO_JEV_USAGE };
  }

  const order = shuffle(candidates.map((_, index) => index));
  const labels = order.map((_, position) => String.fromCharCode(65 + position)); // A, B, C, ...

  const criteria = Object.fromEntries(
    order.map((originalIndex, position) => {
      const { answer, finalSql, previewRows } = describeCandidate(candidates[originalIndex]);
      const description = [
        `Answer: ${answer}`,
        finalSql ? `Final SQL: ${finalSql}` : 'No successful query.',
        previewRows.length ? `Row preview: ${JSON.stringify(previewRows)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return [labels[position], description];
    }),
  );

  const result = await evaluate({
    model: config.routerModel,
    state: { question },
    questions: {
      pick: {
        type: 'choice',
        instructions:
          "Which candidate answers the user's question correctly, using the most reasonable interpretation of the data?",
        criteria,
      },
    },
  });

  const answer = result.answers.pick;
  const chosenLabel = answer.type === 'choice' ? answer.choice : labels[0];
  const chosenPosition = labels.indexOf(chosenLabel);
  const chosenIndex = order[chosenPosition === -1 ? 0 : chosenPosition];

  const probabilities = candidates.map((_, originalIndex) => {
    const position = order.indexOf(originalIndex);
    const label = labels[position];
    return (answer.type === 'choice' ? answer.probabilities?.[label] : undefined) ?? 0;
  });

  return { index: chosenIndex, probabilities, consensus: false, usage: jevUsage(result) };
}
