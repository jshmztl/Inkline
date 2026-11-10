export interface DiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_LINES = 1200;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

export function diffLines(before: string, after: string): DiffResult {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const truncated = beforeLines.length > MAX_LINES || afterLines.length > MAX_LINES;
  const left = beforeLines.slice(0, MAX_LINES);
  const right = afterLines.slice(0, MAX_LINES);
  const rows = left.length;
  const columns = right.length;

  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      table[row][column] =
        left[row] === right[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (left[row] === right[column]) {
      lines.push({ type: 'same', text: left[row] });
      row += 1;
      column += 1;
    } else if (table[row + 1][column] >= table[row][column + 1]) {
      lines.push({ type: 'remove', text: left[row] });
      removed += 1;
      row += 1;
    } else {
      lines.push({ type: 'add', text: right[column] });
      added += 1;
      column += 1;
    }
  }

  while (row < rows) {
    lines.push({ type: 'remove', text: left[row] });
    removed += 1;
    row += 1;
  }

  while (column < columns) {
    lines.push({ type: 'add', text: right[column] });
    added += 1;
    column += 1;
  }

  return { lines, added, removed, truncated };
}
