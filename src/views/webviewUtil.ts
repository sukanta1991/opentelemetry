import * as vscode from 'vscode';

export function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export function htmlShell(
  webview: vscode.Webview,
  nonce: string,
  bodyHtml: string,
  scriptJs: string,
  styleCss: string
): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

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

