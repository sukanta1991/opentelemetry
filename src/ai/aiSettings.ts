// SPDX-License-Identifier: Apache-2.0
// Validation for the otel.ai.* settings. No vscode import, so it can be unit-tested.

import { DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS } from './limits';

export const MAX_REDACT_KEYS = 100;
export const MAX_REDACT_KEY_LENGTH = 128;

export interface AiSettings {
  enabled: boolean;
  redactAttributeKeys: string[];
  maxResultItems: number;
}

export function sanitizeAiSettings(raw: { enabled?: unknown; redactAttributeKeys?: unknown; maxResultItems?: unknown }): AiSettings {
  const keys: string[] = [];
  if (Array.isArray(raw.redactAttributeKeys)) {
    for (const k of raw.redactAttributeKeys) {
      if (typeof k !== 'string') continue;
      const key = k.trim();
      if (!key || key.length > MAX_REDACT_KEY_LENGTH || keys.includes(key)) continue;
      keys.push(key);
      if (keys.length >= MAX_REDACT_KEYS) break;
    }
  }
  const n = raw.maxResultItems;
  const maxResultItems =
    typeof n === 'number' && Number.isFinite(n) ? Math.min(HARD_MAX_ITEMS, Math.max(1, Math.floor(n))) : DEFAULT_MAX_ITEMS;
  return { enabled: raw.enabled === true, redactAttributeKeys: keys, maxResultItems };
}
