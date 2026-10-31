// SPDX-License-Identifier: Apache-2.0
// Log body templates with Drain (He et al., ICWS 2017): a fixed-depth parse tree keyed by token count and
// leading tokens, then a similarity match against the templates in the leaf. Variable tokens (numbers,
// ids, IPs, URLs, quoted text) are masked first. All work is bounded per log. Pure; no vscode import.

import { byCodeUnit } from '../../compare';
import { AttributeValue } from '../model';
import { Budget } from './budget';
import {
  isDigits,
  isEmail,
  isHexId,
  isIdSegment,
  isIpAddress,
  isOpaqueToken,
  isTimestamp,
  isUuid,
} from './classify';

export interface DrainOptions {
  /** Tree depth as in Drain3: root, token-count and leaf levels plus depth - 3 levels of leading tokens. */
  depth: number;
  /** Share of a template's tokens a log must match to join it. */
  similarity: number;
  maxChildren: number;
  maxTemplates: number;
  maxTokens: number;
  maxBodyChars: number;
  sampleChars: number;
}

export const DEFAULT_DRAIN_OPTIONS: Readonly<DrainOptions> = Object.freeze({
  depth: 4,
  similarity: 0.4,
  maxChildren: 100,
  maxTemplates: 1000,
  maxTokens: 64,
  maxBodyChars: 2048,
  sampleChars: 120,
});

export const WILDCARD = '<*>';
/** Text redacted before a sample is cut; long enough that multi-line secrets such as PEM keys are matched whole. */
export const SAMPLE_REDACT_CHARS = 8192;
const MAX_SHAPE_KEYS = 32;
// Quoted text up to 200 chars; one character class inside, so matching stays linear.
const QUOTED = /"[^"\n]{0,200}"/g;
const NUMBER_WITH_UNIT = /^[-+]?\d+(?:\.\d+)?([a-z%\u00b5]{1,3})?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]{0,15}:\/\//i;
const LEADING = new Set(['(', '[', '{', '<', '"', "'"]);
const TRAILING = new Set([')', ']', '}', '>', '"', "'", ',', ';', '.', ':', '!', '?']);

export interface LogTemplate {
  readonly id: number;
  readonly text: string;
  readonly count: number;
  readonly bytes: number;
  readonly firstSeen: number;
  readonly lastSeen: number;
  /** Redacted, truncated first body that created the template. */
  readonly sample: string;
}

interface TreeNode {
  children: Map<string, TreeNode>;
  clusters: Cluster[];
}

interface PathStep {
  parent: Map<string | number, TreeNode>;
  key: string | number;
  node: TreeNode;
}

interface Cluster {
  id: number;
  tokens: string[];
  count: number;
  bytes: number;
  firstSeen: number;
  lastSeen: number;
  sample: string;
  /** Tree nodes from the length node down to the leaf, for pruning on eviction; empty for shape templates. */
  path: PathStep[];
  shape?: string;
}

const newNode = (): TreeNode => ({ children: new Map(), clusters: [] });

function hasDigit(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) return true;
  }
  return false;
}

// Characters that can start a maskable variable; tokens without any skip masking entirely.
function mayVary(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 48 && c <= 57) || c === 64 || c === 47 || c === 61 || c === 58) return true;
  }
  return false;
}

function maskValue(c: string): string {
  if (!c) return c;
  if (isDigits(c)) return '<NUM>';
  const unit = NUMBER_WITH_UNIT.exec(c);
  if (unit) return `<NUM>${unit[1] ?? ''}`;
  if (isUuid(c)) return '<UUID>';
  if (isTimestamp(c)) return '<TS>';
  if (isIpAddress(c)) return '<IP>';
  if (isEmail(c)) return '<EMAIL>';
  if (SCHEME.test(c)) return '<URL>';
  if (c.charCodeAt(0) === 47) return maskPath(c);
  if (isHexId(c, 8)) return '<HEX>';
  if (isOpaqueToken(c)) return '<TOKEN>';
  return c;
}

function maskSegment(seg: string): string {
  if (!seg) return seg;
  if (isIpAddress(seg)) return '<IP>';
  return isIdSegment(seg) ? '<ID>' : seg;
}

function maskPath(c: string): string {
  const q = c.indexOf('?');
  const path = q < 0 ? c : c.slice(0, q);
  const masked = path.split('/').map(maskSegment).join('/');
  return q < 0 ? masked : `${masked}?<QUERY>`;
}

/** Masks a token's variable core, keeping surrounding punctuation and a `key=` / `key:` prefix. */
export function maskToken(t: string): string {
  if (!mayVary(t)) return t;
  let start = 0;
  let end = t.length;
  while (start < end && LEADING.has(t[start])) start++;
  while (end > start && TRAILING.has(t[end - 1])) end--;
  const core = t.slice(start, end);
  let masked = maskValue(core);
  if (masked === core) {
    const sep = core.search(/[=:]/);
    if (sep > 0 && sep < core.length - 1 && !SCHEME.test(core)) {
      masked = core.slice(0, sep + 1) + maskValue(core.slice(sep + 1));
    }
  }
  return masked === core ? t : t.slice(0, start) + masked + t.slice(end);
}

/** Masked tokens of a text body: at most maxBodyChars characters and maxTokens tokens. */
export function tokenize(body: string, opts: Pick<DrainOptions, 'maxBodyChars' | 'maxTokens'> = DEFAULT_DRAIN_OPTIONS): string[] {
  const cut = body.length > opts.maxBodyChars ? body.slice(0, opts.maxBodyChars) : body;
  const text = cut.includes('"') ? cut.replace(QUOTED, '<STR>') : cut;
  const out: string[] = [];
  let i = 0;
  while (i < text.length && out.length < opts.maxTokens) {
    while (i < text.length && text.charCodeAt(i) <= 32) i++;
    const start = i;
    while (i < text.length && text.charCodeAt(i) > 32) i++;
    if (i > start) out.push(maskToken(text.slice(start, i)));
  }
  return out;
}

/** Template for a non-text body: its sorted top-level keys, or its type. */
export function shapeOf(body: AttributeValue): string {
  if (body === null || body === undefined || typeof body === 'string') return '<empty>';
  if (typeof body === 'number') return '<NUM>';
  if (typeof body === 'boolean') return '<BOOL>';
  if (Array.isArray(body)) return '[array]';
  const keys = Object.keys(body as object).sort(byCodeUnit);
  const shown = keys.slice(0, MAX_SHAPE_KEYS).join(',');
  return `{${shown}${keys.length > MAX_SHAPE_KEYS ? ',…' : ''}}`;
}

/**
 * Groups log bodies into templates. Capped at maxTemplates (and an optional shared budget); at the cap the
 * oldest template seen only once is folded into "(other)" to make room, and with none such the log itself
 * counts as other.
 */
export class DrainTemplater {
  private readonly opts: DrainOptions;
  private readonly byLength = new Map<number, TreeNode>();
  private readonly shapes = new Map<string, Cluster>();
  private readonly all = new Set<Cluster>();
  // Insertion-ordered, so the first entry is the oldest single-use template.
  private readonly singletons = new Set<Cluster>();
  private nextId = 1;
  private otherCount = 0;
  private otherBytes = 0;

  constructor(
    opts: Partial<DrainOptions> = {},
    private readonly budget?: Budget,
    private readonly redact: (s: string) => string = (s) => s
  ) {
    this.opts = { ...DEFAULT_DRAIN_OPTIONS, ...opts };
    const o = this.opts;
    if (!(o.depth >= 3 && o.similarity >= 0 && o.similarity <= 1 && o.maxChildren >= 2 && o.maxTemplates >= 1 && o.maxTokens >= 1 && o.maxBodyChars >= 1 && o.sampleChars >= 1)) {
      throw new RangeError('invalid Drain options');
    }
  }

  get size(): number {
    return this.all.size;
  }

  get other(): { count: number; bytes: number } {
    return { count: this.otherCount, bytes: this.otherBytes };
  }

  /** Adds one log body; returns its template id, or 0 when it was counted as other. */
  add(body: AttributeValue, timeMs: number, bytes: number): number {
    if (typeof body === 'string' && body) {
      const tokens = tokenize(body, this.opts);
      if (tokens.length) return this.addTokens(tokens, body, timeMs, bytes);
    }
    return this.addShape(shapeOf(body), body, timeMs, bytes);
  }

  /** Templates by count (descending), then id. */
  templates(): LogTemplate[] {
    return [...this.all]
      .sort((a, b) => b.count - a.count || a.id - b.id)
      .map((c) => ({
        id: c.id,
        text: c.shape ?? c.tokens.join(' '),
        count: c.count,
        bytes: c.bytes,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        sample: c.sample,
      }));
  }

  /** Releases the shared budget held by this templater's templates. */
  dispose(): void {
    this.budget?.release(this.all.size);
    this.all.clear();
    this.singletons.clear();
    this.shapes.clear();
    this.byLength.clear();
  }

  private addTokens(tokens: string[], body: string, timeMs: number, bytes: number): number {
    const match = this.search(tokens);
    if (match) {
      for (let i = 0; i < tokens.length; i++) if (match.tokens[i] !== tokens[i]) match.tokens[i] = WILDCARD;
      return this.hit(match, timeMs, bytes);
    }
    if (!this.makeRoom()) return this.miss(bytes);
    const cluster = this.create(tokens.slice(), body, timeMs, bytes);
    let parent: Map<string | number, TreeNode> = this.byLength;
    let node = this.byLength.get(tokens.length);
    if (!node) this.byLength.set(tokens.length, (node = newNode()));
    cluster.path.push({ parent, key: tokens.length, node });
    const levels = Math.min(this.opts.depth - 3, tokens.length);
    for (let i = 0; i < levels; i++) {
      let key = hasDigit(tokens[i]) ? WILDCARD : tokens[i];
      // Keep one slot for the wildcard child so a node never exceeds maxChildren.
      if (!node.children.has(key) && key !== WILDCARD && node.children.size >= this.opts.maxChildren - 1) key = WILDCARD;
      parent = node.children;
      let child = node.children.get(key);
      if (!child) node.children.set(key, (child = newNode()));
      cluster.path.push({ parent, key, node: child });
      node = child;
    }
    node.clusters.push(cluster);
    return cluster.id;
  }

  private search(tokens: string[]): Cluster | undefined {
    let node = this.byLength.get(tokens.length);
    const levels = Math.min(this.opts.depth - 3, tokens.length);
    for (let i = 0; node && i < levels; i++) {
      const key = hasDigit(tokens[i]) ? WILDCARD : tokens[i];
      node = node.children.get(key) ?? node.children.get(WILDCARD);
    }
    if (!node) return undefined;
    let best: Cluster | undefined;
    let bestSim = -1;
    let bestParams = -1;
    for (const c of node.clusters) {
      let same = 0;
      let params = 0;
      for (let i = 0; i < tokens.length; i++) {
        if (c.tokens[i] === WILDCARD) params++;
        else if (c.tokens[i] === tokens[i]) same++;
      }
      const sim = same / tokens.length;
      if (sim > bestSim || (sim === bestSim && params > bestParams)) {
        best = c;
        bestSim = sim;
        bestParams = params;
      }
    }
    return best && bestSim >= this.opts.similarity ? best : undefined;
  }

  private addShape(shape: string, body: AttributeValue, timeMs: number, bytes: number): number {
    const existing = this.shapes.get(shape);
    if (existing) return this.hit(existing, timeMs, bytes);
    if (!this.makeRoom()) return this.miss(bytes);
    const cluster = this.create([], typeof body === 'string' ? body : safeJson(body, SAMPLE_REDACT_CHARS), timeMs, bytes);
    cluster.shape = shape;
    this.shapes.set(shape, cluster);
    return cluster.id;
  }

  private hit(c: Cluster, timeMs: number, bytes: number): number {
    c.count++;
    c.bytes += bytes;
    if (timeMs < c.firstSeen) c.firstSeen = timeMs;
    if (timeMs > c.lastSeen) c.lastSeen = timeMs;
    this.singletons.delete(c);
    return c.id;
  }

  private miss(bytes: number): number {
    this.otherCount++;
    this.otherBytes += bytes;
    return 0;
  }

  private create(tokens: string[], body: string, timeMs: number, bytes: number): Cluster {
    const text = body.length > SAMPLE_REDACT_CHARS ? body.slice(0, SAMPLE_REDACT_CHARS) : body;
    const redacted = this.redact(text);
    const cluster: Cluster = {
      id: this.nextId++,
      tokens,
      count: 1,
      bytes,
      firstSeen: timeMs,
      lastSeen: timeMs,
      sample: redacted.length > this.opts.sampleChars ? `${redacted.slice(0, this.opts.sampleChars)}…` : redacted,
      path: [],
    };
    this.all.add(cluster);
    this.singletons.add(cluster);
    return cluster;
  }

  /** Ensures one template slot is free (evicting the oldest single-use template if needed). */
  private makeRoom(): boolean {
    const full = this.all.size >= this.opts.maxTemplates;
    if (!full && (!this.budget || this.budget.tryAcquire())) return true;
    const victim = this.singletons.values().next().value as Cluster | undefined;
    if (!victim) return false;
    // The victim's budget slot passes to the new template.
    this.evict(victim);
    return true;
  }

  private evict(c: Cluster): void {
    this.otherCount += c.count;
    this.otherBytes += c.bytes;
    this.all.delete(c);
    this.singletons.delete(c);
    if (c.shape !== undefined) {
      this.shapes.delete(c.shape);
      return;
    }
    const leaf = c.path[c.path.length - 1].node;
    leaf.clusters.splice(leaf.clusters.indexOf(c), 1);
    for (let i = c.path.length - 1; i >= 0; i--) {
      const { parent, key, node } = c.path[i];
      if (node.clusters.length || node.children.size) break;
      parent.delete(key);
    }
  }
}

function safeJson(v: AttributeValue, max: number): string {
  try {
    const s = JSON.stringify(v) ?? '';
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return '';
  }
}
