// SPDX-License-Identifier: Apache-2.0
// Shape and bounds of the cardinality summary stored in baselines. Types and constants only, with no Node
// or vscode import, so the baseline types stay usable from webviews. Summaries hold key names, counts and
// classes only: never values or samples.

import { MAX_KEY_CHARS } from '../store/cardinality/budget';
import { Signal, Volume } from '../store/cardinality/sizes';
import { ValueClass } from '../store/cardinality/valueClass';

export type SummaryScope = 'span' | 'span.event' | 'log';

export interface SummaryKey {
  scope: SummaryScope;
  key: string;
  distinct: number;
  approx: boolean;
  occurrences: number;
  proto: number;
  cls?: ValueClass;
}

export interface SummaryMetric {
  name: string;
  series: number;
  approx: boolean;
  points: number;
  /** Label with the most unique values. */
  driver?: string;
}

export interface ServiceSummary {
  service: string;
  totals: Record<Signal, Volume>;
  perMinute: Record<Signal, Volume>;
  observedMs: number;
  spanNames: number;
  templates: number;
  keys: SummaryKey[];
  keysTruncated: boolean;
  metrics: SummaryMetric[];
  metricsTruncated: boolean;
}

/** Usage counters of a realm up to capture time (since counting started, not limited to a map window). */
export interface CardinalitySummary {
  fromMs: number;
  toMs: number;
  windowMinutes: number;
  services: ServiceSummary[];
  truncated: boolean;
}

export type ChangeVerdict = 'new' | 'grown' | 'resolved';

export interface CardinalityChange {
  verdict: ChangeVerdict;
  kind: 'attribute' | 'metric';
  service: string;
  signal: Signal;
  scope?: SummaryScope;
  /** Attribute key or metric name. */
  key: string;
  /** Unique values (series for metrics) before and after; undefined when absent on that side. */
  base?: number;
  current?: number;
  cls?: ValueClass;
  driver?: string;
}

export interface VolumeChange {
  service: string;
  signal: Signal;
  /** Records per minute. */
  base: number;
  current: number;
  /** current / base - 1; Infinity when the signal appeared. */
  change: number;
  baseBytes: number;
  currentBytes: number;
}

export interface CardinalityComparison {
  changes: CardinalityChange[];
  volume: VolumeChange[];
  summary: Record<ChangeVerdict, number>;
  addedServices: string[];
  missingServices: string[];
}

/** Bounds shared by capture and the baseline file validator. */
export const SUMMARY_LIMITS = Object.freeze({
  services: 500,
  keysPerService: 200,
  keysTotal: 1000,
  metricsPerService: 200,
  metricsTotal: 1000,
  serviceName: 2000,
  keyName: MAX_KEY_CHARS,
});
