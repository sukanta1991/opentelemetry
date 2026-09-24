import * as vscode from 'vscode';
import { OtelController } from '../controller';
import { normalizeSpanId, normalizeTraceId } from '../store/ids';
import { shortId } from './format';
import { LogsPanel } from './logsPanel';
import { pickTraceInstance } from './navigationTargets';
import { TracesPanel } from './tracesPanel';

export interface RevealTraceArgs {
  traceId: string;
  spanId?: string;
  preferInstanceId?: string;
}

export interface RevealLogsArgs {
  traceId: string;
  spanId?: string;
  instanceId?: string;
  focusSeq?: number;
}

export function revealTrace(controller: OtelController, args: RevealTraceArgs): void {
  const traceId = normalizeTraceId(args.traceId);
  if (!traceId) {
    vscode.window.showInformationMessage(
      `"${String(args.traceId).slice(0, 64)}" is not a W3C trace ID, so it cannot be looked up.`
    );
    return;
  }
  const instanceId = pickTraceInstance(controller.store, traceId, args.preferInstanceId);
  if (!instanceId) {
    vscode.window.showInformationMessage(
      `Trace ${shortId(traceId)} is not in collected data (not exported, evicted, or from an imported file).`
    );
    return;
  }
  TracesPanel.show(controller, instanceId, { traceId, spanId: normalizeSpanId(args.spanId) });
}

export async function revealLogs(controller: OtelController, args: RevealLogsArgs): Promise<void> {
  const traceId = normalizeTraceId(args.traceId);
  if (!traceId) return;
  const spanId = normalizeSpanId(args.spanId);
  const store = controller.store;
  const correlate = { traceId, spanId, focusSeq: args.focusSeq };

  if (args.instanceId && store.getInstance(args.instanceId)) {
    LogsPanel.show(controller, args.instanceId, { correlate });
    return;
  }

  const counts = [...store.countLogsByInstance(traceId, spanId)];
  if (!counts.length) {
    const what = spanId ? `span ${shortId(spanId)}` : `trace ${shortId(traceId)}`;
    vscode.window.showInformationMessage(
      `No logs are correlated with ${what} (they may lack trace context or have been evicted).`
    );
    return;
  }
  if (counts.length === 1) {
    LogsPanel.show(controller, counts[0][0], { correlate });
    return;
  }
  const pick = await vscode.window.showQuickPick(
    counts.map(([id, n]) => {
      const inst = store.getInstance(id);
      return {
        label: inst?.serviceName ?? id,
        description: inst?.source ?? inst?.serviceInstanceId ?? id,
        detail: `${n} correlated log${n === 1 ? '' : 's'}`,
        id,
      };
    }),
    { placeHolder: 'Logs for this trace come from several instances — pick one' }
  );
  if (pick) LogsPanel.show(controller, pick.id, { correlate });
}
