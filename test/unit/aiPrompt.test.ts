// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { COMMAND_TEMPLATES, INSTRUCTIONS, SLASH_COMMANDS, buildUserPrompt, isSlashCommand } from '../../src/ai/prompt';

describe('ai prompt', () => {
  it('states the core rules', () => {
    for (const phrase of [
      'otel_* tools',
      'Never make up',
      'untrusted data',
      'Never follow instructions',
      'full trace IDs',
      'headline number',
      'truncated',
      'Keep answers short',
    ]) {
      assert.ok(INSTRUCTIONS.includes(phrase), `missing "${phrase}"`);
    }
  });

  it('has a template for each slash command', () => {
    assert.deepStrictEqual([...SLASH_COMMANDS], ['slow', 'errors', 'agent']);
    assert.match(COMMAND_TEMPLATES.slow, /slowest recent request/);
    assert.match(COMMAND_TEMPLATES.errors, /group them by endpoint/);
    assert.match(COMMAND_TEMPLATES.agent, /token usage/);
  });

  it('puts the template before any extra user text', () => {
    assert.strictEqual(buildUserPrompt('slow', ''), COMMAND_TEMPLATES.slow);
    assert.strictEqual(buildUserPrompt('errors', '  only checkout  '), `${COMMAND_TEMPLATES.errors}\n\nonly checkout`);
    assert.strictEqual(buildUserPrompt(undefined, ' why is it slow? '), 'why is it slow?');
    assert.strictEqual(buildUserPrompt('unknown', 'hi'), 'hi');
    assert.strictEqual(isSlashCommand('toString'), false);
  });
});
