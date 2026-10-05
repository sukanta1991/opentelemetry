// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { HARD_MAX_ITEMS } from '../../src/ai/limits';
import { SLASH_COMMANDS } from '../../src/ai/prompt';
import { SEVERITY_NUMBER, SPAN_GROUPS, SPAN_SORTS, STATUS_VALUES, TRACE_SORTS } from '../../src/ai/toolInputs';
import { TOOL_NAMES } from '../../src/ai/toolNames';
import { parseToolInput, toolTitle } from '../../src/ai/toolRunner';

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const tools: any[] = pkg.contributes.languageModelTools;
const tool = (name: string) => tools.find((t) => t.name === name);
const props = (name: string) => tool(name).inputSchema.properties;

describe('ai manifest (package.json)', () => {
  it('contributes exactly the TOOL_NAMES tools, in order', () => {
    assert.deepStrictEqual(
      tools.map((t) => t.name),
      [...TOOL_NAMES]
    );
  });

  it('gives every tool the required metadata and the opt-in when clause', () => {
    const refs = new Set<string>();
    for (const t of tools) {
      assert.strictEqual(t.displayName, toolTitle(t.name), `${t.name} displayName`);
      assert.match(t.name, /^[\w-]+$/);
      assert.match(t.toolReferenceName, /^[\w-]+$/);
      assert.ok(!refs.has(t.toolReferenceName), `duplicate toolReferenceName ${t.toolReferenceName}`);
      refs.add(t.toolReferenceName);
      assert.strictEqual(t.canBeReferencedInPrompt, true);
      assert.strictEqual(t.when, 'config.otel.ai.enabled');
      assert.strictEqual(t.icon, '$(pulse)');
      assert.ok(t.userDescription.length > 20, `${t.name} userDescription`);
      assert.ok(t.modelDescription.length > 100, `${t.name} modelDescription`);
      const allowed = ['name', 'displayName', 'toolReferenceName', 'canBeReferencedInPrompt', 'icon', 'when', 'userDescription', 'modelDescription', 'inputSchema', 'tags'];
      assert.deepStrictEqual(Object.keys(t).filter((k) => !allowed.includes(k)), [], `${t.name} has keys VS Code rejects`);
    }
  });

  it('uses object input schemas with a description on every property', () => {
    for (const t of tools) {
      const s = t.inputSchema;
      assert.strictEqual(s.type, 'object', t.name);
      for (const [key, p] of Object.entries<any>(s.properties)) {
        assert.ok(typeof p.description === 'string' && p.description.length > 10, `${t.name}.${key} description`);
        assert.ok(['string', 'number', 'integer', 'boolean'].includes(p.type), `${t.name}.${key} type`);
      }
      for (const r of s.required ?? []) assert.ok(r in s.properties, `${t.name} requires unknown ${r}`);
    }
    assert.deepStrictEqual(tool('otel_compareTraces').inputSchema.required, ['traceId']);
    assert.ok(tools.filter((t) => t.name !== 'otel_compareTraces').every((t) => !t.inputSchema.required));
  });

  it('declares exactly the fields each input parser reads', () => {
    for (const name of TOOL_NAMES) {
      const parsed = parseToolInput(name, name === 'otel_compareTraces' ? { traceId: 'x' } : {}, 25);
      assert.ok('value' in parsed, name);
      assert.deepStrictEqual(Object.keys(props(name)).sort(), Object.keys(parsed.value as object).sort(), name);
    }
  });

  it('keeps enums and limits in sync with the parsers', () => {
    assert.deepStrictEqual(props('otel_searchTraces').status.enum, [...STATUS_VALUES]);
    assert.deepStrictEqual(props('otel_findSpans').status.enum, [...STATUS_VALUES]);
    assert.deepStrictEqual([...props('otel_searchTraces').sort.enum].sort(), [...TRACE_SORTS].sort());
    assert.deepStrictEqual(props('otel_findSpans').sort.enum, [...SPAN_SORTS]);
    assert.deepStrictEqual(props('otel_findSpans').groupBy.enum, [...SPAN_GROUPS]);
    assert.deepStrictEqual(props('otel_queryLogs').minSeverity.enum, Object.keys(SEVERITY_NUMBER));
    for (const t of tools) {
      const limit = t.inputSchema.properties.limit;
      if (limit) assert.deepStrictEqual([limit.minimum, limit.maximum], [1, HARD_MAX_ITEMS], t.name);
    }
  });

  it('keeps AI access off by default and application-scoped', () => {
    const cfg = pkg.contributes.configuration.properties;
    assert.strictEqual(cfg['otel.ai.enabled'].default, false);
    assert.strictEqual(cfg['otel.ai.enabled'].scope, 'application');
    assert.deepStrictEqual(cfg['otel.ai.redactAttributeKeys'].default, []);
    assert.strictEqual(cfg['otel.ai.redactAttributeKeys'].maxItems, 100);
    assert.strictEqual(cfg['otel.ai.redactAttributeKeys'].items.maxLength, 128);
    assert.deepStrictEqual(
      [cfg['otel.ai.maxResultItems'].default, cfg['otel.ai.maxResultItems'].minimum, cfg['otel.ai.maxResultItems'].maximum],
      [25, 1, HARD_MAX_ITEMS]
    );
  });

  it('pins @types/vscode to the minimum engine version', () => {
    const engine = pkg.engines.vscode.replace(/^\^/, '');
    assert.strictEqual(pkg.devDependencies['@types/vscode'], engine);
  });

  it('contributes the otel.chat participant with the three slash commands', () => {
    const participants: any[] = pkg.contributes.chatParticipants;
    assert.strictEqual(participants.length, 1);
    const [p] = participants;
    assert.deepStrictEqual(
      { id: p.id, name: p.name, fullName: p.fullName, isSticky: p.isSticky },
      { id: 'otel.chat', name: 'otel', fullName: 'OpenTelemetry', isSticky: true }
    );
    assert.ok(p.description.length > 20);
    assert.deepStrictEqual(
      p.commands.map((c: any) => c.name),
      [...SLASH_COMMANDS]
    );
    assert.ok(p.commands.every((c: any) => typeof c.description === 'string' && c.description.length > 10));
  });

  it('adds no runtime dependencies', () => {
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs']);
  });
});
