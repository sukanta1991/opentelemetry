import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export function getNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function getUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  ...pathSegments: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathSegments));
}

export function htmlShell(
  webview: vscode.Webview,
  nonce: string,
  bodyHtml: string,
  scriptJs: string,
  styleCss: string,
  scriptUris: vscode.Uri[] = []
): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  const externalScripts = scriptUris
    .map((uri) => `<script nonce="${nonce}" src="${uri.toString()}"></script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${baseCss}${styleCss}</style>
</head>
<body>
${bodyHtml}
${externalScripts}
<script nonce="${nonce}">${scriptJs}</script>
</body>
</html>`;
}

const baseCss = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0;
    display: flex; flex-direction: column;
    height: 100vh; overflow: hidden;
  }
  .toolbar {
    flex: 0 0 auto; z-index: 5;
    display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
    padding: 8px; background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  /* Scrollable region that holds a table with a sticky header. */
  .rows { flex: 1 1 auto; overflow: auto; }
  input, select, button {
    font-family: inherit; font-size: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    padding: 3px 6px; border-radius: 2px;
  }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left; padding: 3px 8px; vertical-align: top;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-variant-numeric: tabular-nums;
  }
  th {
    position: sticky; top: 0; z-index: 2;
    background: var(--vscode-editor-background);
    box-shadow: inset 0 -1px 0 var(--vscode-panel-border);
  }
  tr.selectable { cursor: pointer; }
  tr.selectable:hover { background: var(--vscode-list-hoverBackground); }
  tr.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .muted { color: var(--vscode-descriptionForeground); }
  .empty { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
  code, pre { font-family: var(--vscode-editor-font-family, monospace); }
`;

// Resizable/sortable columns, the column picker popover and the time-range picker.
export const COLUMN_TABLE_CSS = `
  table { table-layout: fixed; }
  th.sortable { cursor: pointer; }
  th .sort-ind { margin-left: 4px; opacity: 0.8; }
  .col-resizer {
    position: absolute; top: 0; right: -3px; width: 7px; height: 100%;
    cursor: col-resize; user-select: none; z-index: 3; touch-action: none;
  }
  .col-resizer::after {
    content: ''; position: absolute; top: 20%; right: 3px; width: 1px; height: 60%;
    background: var(--vscode-panel-border);
  }
  th:hover .col-resizer::after { background: var(--vscode-focusBorder); }
  body.col-resizing { cursor: col-resize; user-select: none; }
  tr.spacer td { padding: 0; border: 0; }
  th.measuring, td.measuring { white-space: nowrap !important; }

  .popover {
    position: fixed; z-index: 20; min-width: 280px; max-width: 360px;
    max-height: 70vh; overflow: auto; padding: 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .popover[hidden] { display: none; }
  .popover-head { display: flex; gap: 6px; margin-bottom: 6px; }
  .popover-head input { flex: 1 1 auto; min-width: 0; }
  .col-group {
    margin: 10px 0 2px; font-size: 0.82em; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--vscode-descriptionForeground);
  }
  .col-item {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 4px; border-radius: 3px;
  }
  .col-item:hover { background: var(--vscode-list-hoverBackground); }
  .col-item label {
    display: flex; align-items: center; gap: 6px;
    flex: 1 1 auto; min-width: 0; cursor: pointer;
  }
  .col-item label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .shown-item { cursor: grab; }
  .shown-item.dragging { opacity: 0.4; }
  .shown-item.drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .shown-item.drop-after { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  .drag-handle { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
  .hide-btn {
    flex: 0 0 auto; background: none; border: none; padding: 0 4px;
    color: var(--vscode-descriptionForeground); cursor: pointer;
  }
  .hide-btn:hover { background: none; color: var(--vscode-foreground); }
  .col-note { padding: 4px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }

  .range-picker {
    display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 3px;
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  }
  .range-picker:focus-within { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .range-picker .range-icon { flex: 0 0 auto; opacity: 0.8; }
  .range-picker select { border: none; background: transparent; color: inherit; font-size: 0.9em; padding: 2px 0; }
  .range-picker select:focus { outline: none; }
`;

export const RANGE_ICON_SVG =
  '<svg class="range-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.5A5.5 5.5 0 1 1 8 13.5 5.5 5.5 0 0 1 8 2.5zM7.25 4v4.31l3 1.73.75-1.3-2.25-1.3V4h-1.5z"/></svg>';

