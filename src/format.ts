/**
 * Rendering helpers for the text half of every tool result.
 *
 * The audience is a language model with a finite context window, so the goal
 * throughout is compression without loss of meaning: "2m 40s" rather than
 * 160000, a sparkline rather than 200 rows, "12 days ago" rather than an
 * ISO timestamp the model has to reason about.
 */

export function humanBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function humanDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * "12 days ago" / "in 3 days". `now` is injectable so tests are not clocks.
 */
export function relativeTime(iso: string | undefined | null, now: Date = new Date()): string {
  if (!iso) return "unknown";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "unknown";

  const deltaMs = then.getTime() - now.getTime();
  const future = deltaMs > 0;
  const abs = Math.abs(deltaMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let phrase: string;
  if (abs < minute) phrase = "moments";
  else if (abs < hour) phrase = plural(Math.round(abs / minute), "minute");
  else if (abs < day) phrase = plural(Math.round(abs / hour), "hour");
  else if (abs < 60 * day) phrase = plural(Math.round(abs / day), "day");
  else if (abs < 365 * day) phrase = plural(Math.round(abs / (30 * day)), "month");
  else phrase = plural(Math.round(abs / (365 * day)), "year");

  return future ? `in ${phrase}` : `${phrase} ago`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** An absolute UTC timestamp, for event lines where ordering matters. */
export function shortTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * A GitHub-flavoured markdown table. Cells are stringified as-is; `|` is
 * escaped so a filename can never break the layout.
 */
export function markdownTable(headers: string[], rows: (string | number)[][]): string {
  const escape = (cell: string | number): string => String(cell).replace(/\|/g, "\\|");
  const lines = [
    `| ${headers.map(escape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`),
  ];
  return lines.join("\n");
}

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

/**
 * A one-line bar, 0..1 of `width` cells, using eighth-block characters so
 * small differences stay visible at narrow widths.
 */
export function bar(fraction: number, width = 12): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const remainder = eighths % 8;
  return "█".repeat(full) + (remainder ? BLOCKS[remainder] : "");
}

/**
 * Picks at most `count` evenly-spaced entries, always keeping the first and
 * last. Used to sample a long page list down to a readable sparkline without
 * hiding where it starts or ends.
 */
export function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 1) return items.length ? [items[0]!] : [];
  const step = (items.length - 1) / (count - 1);
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[Math.round(i * step)]!);
  return picked;
}

export function pct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value)}%`;
}

/** Joins non-empty sections with a blank line between them. */
export function paragraphs(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join("\n\n");
}
