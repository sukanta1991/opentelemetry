// SPDX-License-Identifier: Apache-2.0
// Cross-checks between package.json contributions: links, menus and walkthrough media.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { configProperties } from './manifestUtil';

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributed = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
const walkthroughs: any[] = pkg.contributes.walkthroughs ?? [];
const steps: any[] = walkthroughs.flatMap((w) => w.steps);

function commandLinks(text: string): string[] {
  return [...text.matchAll(/\(command:([\w.]+)/g)].map((m) => m[1]);
}

function assertKnown(cmd: string, where: string): void {
  assert.ok(contributed.has(cmd) || cmd.startsWith('workbench.'), `${where}: unknown command ${cmd}`);
}

describe('package.json manifest', () => {
  it('groups every setting into exactly one titled, ordered section', () => {
    const sections: any[] = pkg.contributes.configuration;
    assert.ok(Array.isArray(sections));
    assert.deepStrictEqual(
      sections.map((s) => s.title),
      ['General', 'Receiver', 'Retention & Import', 'Service Map', 'Service Map Baselines', 'Cardinality', 'Cost Estimates', 'AI']
    );
    assert.deepStrictEqual(
      sections.map((s) => s.order),
      sections.map((_, i) => i + 1)
    );
    const keys = sections.flatMap((s) => Object.keys(s.properties));
    assert.strictEqual(new Set(keys).size, keys.length, 'a setting appears in two sections');
    assert.strictEqual(keys.length, Object.keys(configProperties(pkg)).length);
    assert.ok(keys.every((k) => k.startsWith('otel.')));
  });

  it('stays within Marketplace listing limits', () => {
    const keywords: string[] = pkg.keywords;
    assert.ok(keywords.length <= 30, `${keywords.length} keywords; the Marketplace allows 30`);
    assert.strictEqual(new Set(keywords.map((k) => k.toLowerCase())).size, keywords.length, 'duplicate keyword');
    assert.strictEqual(pkg.displayName, 'OpenTelemetry');
  });

  it('welcome view links point to contributed commands', () => {
    const links = pkg.contributes.viewsWelcome.flatMap((v: { contents: string }) => commandLinks(v.contents));
    assert.ok(links.length > 0);
    for (const cmd of links) assertKnown(cmd, 'viewsWelcome');
  });

  it('every menu entry points to a contributed command', () => {
    for (const [menu, entries] of Object.entries<any[]>(pkg.contributes.menus)) {
      for (const e of entries) assert.ok(contributed.has(e.command), `${menu}: unknown command ${e.command}`);
    }
  });

  it('has the getting-started walkthrough', () => {
    assert.deepStrictEqual(
      walkthroughs.map((w) => w.id),
      ['otel.gettingStarted']
    );
    assert.deepStrictEqual(
      steps.map((s) => s.id),
      ['start', 'connect', 'explore', 'serviceMap', 'baseline', 'cardinality', 'ai']
    );
  });

  it('walkthrough links and completion commands are contributed', () => {
    for (const s of steps) {
      for (const cmd of commandLinks(s.description)) assertKnown(cmd, `step ${s.id}`);
      for (const ev of s.completionEvents ?? []) {
        const m = /^onCommand:(.+)$/.exec(ev);
        if (m) assert.ok(contributed.has(m[1]), `step ${s.id}: unknown completion command ${m[1]}`);
      }
      const md = s.media.markdown;
      if (md) for (const cmd of commandLinks(fs.readFileSync(path.join(root, md), 'utf8'))) assertKnown(cmd, md);
    }
  });

  it('walkthrough media exists, is small and is packaged', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n');
    assert.ok(!ignore.some((l) => l.trim().startsWith('media')), '.vscodeignore must not exclude media/');
    for (const s of steps) {
      const file = s.media.image ?? s.media.markdown ?? s.media.svg;
      assert.ok(file && fs.existsSync(path.join(root, file)), `step ${s.id}: missing media ${file}`);
      if (s.media.image) {
        assert.ok(s.media.altText, `step ${s.id}: image needs altText`);
        assert.ok(fs.statSync(path.join(root, file)).size <= 150 * 1024, `step ${s.id}: ${file} over 150 KB`);
      }
    }
  });
});
