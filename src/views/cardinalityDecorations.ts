// SPDX-License-Identifier: Apache-2.0
// File decorations for Instances tree items: a count of warning and critical cardinality findings.

import * as vscode from 'vscode';
import { CardinalityEvaluator, decorationBadge, decorationTooltip } from './cardinalityEvaluator';

export const CARDINALITY_SCHEME = 'otel-card';

/** Tree items carry this as `resourceUri` so the provider can decorate them. */
export function cardinalityUri(key: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CARDINALITY_SCHEME, path: `/${encodeURIComponent(key)}` });
}

function keyOf(uri: vscode.Uri): string | undefined {
  try {
    return decodeURIComponent(uri.path.slice(1));
  } catch {
    return undefined;
  }
}

export class CardinalityDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly sub: { dispose(): void };

  constructor(private readonly evaluator: CardinalityEvaluator) {
    this.sub = evaluator.onDidChange((_, changed) => {
      if (changed.length) this.emitter.fire(changed.map(cardinalityUri));
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CARDINALITY_SCHEME) return undefined;
    const key = keyOf(uri);
    const node = key === undefined ? undefined : this.evaluator.current.nodes.get(key);
    const badge = node && decorationBadge(node);
    if (!node || !badge) return undefined;
    const color = new vscode.ThemeColor(node.critical ? 'list.errorForeground' : 'list.warningForeground');
    return new vscode.FileDecoration(badge, decorationTooltip(node), color);
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
