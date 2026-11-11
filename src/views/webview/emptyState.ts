// SPDX-License-Identifier: Apache-2.0
// What the Traces, Logs and Metrics panels show when their list is empty. Pure; no DOM.

export type EmptySignal = 'traces' | 'logs' | 'metrics';
export type EmptyCase = 'gone' | 'none' | 'filtered';

export interface EmptyContent {
  title: string;
  hint?: string;
  /** Shown as code after the hint, e.g. the exporter variable to set. */
  code?: string;
  /** Offer a "Clear filters" button. */
  clear: boolean;
}

export function emptyCase(gone: boolean, total: number, shown: number): EmptyCase | undefined {
  if (gone) return 'gone';
  if (total === 0) return 'none';
  return shown === 0 ? 'filtered' : undefined;
}

const NONE: Record<EmptySignal, EmptyContent> = {
  traces: {
    title: 'No traces from this service yet.',
    hint: 'Traces appear as soon as its SDK exports spans over OTLP. If the service sends logs or metrics but no traces, enable the trace exporter:',
    code: 'OTEL_TRACES_EXPORTER=otlp',
    clear: false,
  },
  logs: {
    title: 'No logs from this service yet.',
    hint: 'Logs appear when its SDK exports them over OTLP. Many SDKs also need a logging bridge (appender) so your log calls are forwarded. Enable the log exporter with:',
    code: 'OTEL_LOGS_EXPORTER=otlp',
    clear: false,
  },
  metrics: {
    title: 'No metrics from this service yet.',
    hint: 'Metrics appear after the SDK’s first export, which by default runs every 60 seconds. Enable the metric exporter with:',
    code: 'OTEL_METRICS_EXPORTER=otlp',
    clear: false,
  },
};

export function emptyContent(signal: EmptySignal, c: EmptyCase): EmptyContent {
  if (c === 'gone') {
    return {
      title: 'This instance is no longer available.',
      hint: 'It was removed or its data was cleared. Open another instance from the OpenTelemetry sidebar.',
      clear: false,
    };
  }
  if (c === 'filtered') return { title: `No ${signal} match the current filters.`, clear: true };
  return NONE[signal];
}
