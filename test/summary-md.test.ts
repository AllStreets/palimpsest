/**
 * A run's summary in the Brief: its markdown set as paragraphs and lists with
 * bold, italics and inline code, and anything else, HTML included, kept as
 * the literal text it is.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summaryBlocks, summaryNodes, type NodeMaker } from '../app/src/ui/summary-md.js';

/** A document that records what is built and has no way to parse markup. */
class FakeNode {
  children: FakeNode[] = [];
  className = '';
  attributes: Record<string, string> = {};
  constructor(
    readonly tag: string,
    public text = '',
  ) {}
  set textContent(t: string) {
    this.text = t;
  }
  setAttribute(k: string, v: string) {
    this.attributes[k] = v;
  }
  append(...n: FakeNode[]) {
    this.children.push(...n);
  }
  set innerHTML(_: string) {
    throw new Error('innerHTML was used');
  }
}
const doc = {
  createElement: (tag: string) => new FakeNode(tag),
  createTextNode: (text: string) => new FakeNode('#text', text),
} as unknown as NodeMaker;

function tags(n: FakeNode): string[] {
  return [n.tag, ...n.children.flatMap(tags)];
}
function text(n: FakeNode): string {
  return n.tag === '#text' || !n.children.length ? n.text : n.children.map(text).join('');
}

const REAL = `**What changed**
- **\`tools/commute-check.ts\`**: follows a walker the sample city has when the commute retries.
- Kept the *tram leg* in the clip, see \`clip.ts\`.

The tests pass.`;

test('the summary that showed raw is set as a bold line, a list and a paragraph', () => {
  const blocks = summaryBlocks(REAL);
  assert.deepEqual(blocks, [
    { kind: 'para', spans: [{ kind: 'strong', text: 'What changed' }] },
    {
      kind: 'list',
      items: [
        [
          { kind: 'code', text: 'tools/commute-check.ts' },
          { kind: 'text', text: ': follows a walker the sample city has when the commute retries.' },
        ],
        [
          { kind: 'text', text: 'Kept the ' },
          { kind: 'em', text: 'tram leg' },
          { kind: 'text', text: ' in the clip, see ' },
          { kind: 'code', text: 'clip.ts' },
          { kind: 'text', text: '.' },
        ],
      ],
    },
    { kind: 'para', spans: [{ kind: 'text', text: 'The tests pass.' }] },
  ]);
  const nodes = summaryNodes(blocks, doc) as unknown as FakeNode[];
  assert.deepEqual(nodes.map((n) => n.tag), ['p', 'ul', 'p']);
  assert.ok(!nodes.map(text).join(' ').includes('**'), 'no raw markup is left');
});

test('a script tag or an HTML attribute in the summary is shown as text and never built', () => {
  const evil = 'Fixed it <script>alert(1)</script> and <img src=x onerror="alert(2)">\n- <a href="javascript:alert(3)">**click**</a>';
  const nodes = summaryNodes(summaryBlocks(evil), doc) as unknown as FakeNode[];
  const all = nodes.flatMap(tags);
  assert.deepEqual([...new Set(all)].sort(), ['#text', 'li', 'p', 'strong', 'ul']);
  assert.ok(nodes.flatMap(function walk(n: FakeNode): FakeNode[] {
    return [n, ...n.children.flatMap(walk)];
  }).every((n) => Object.keys(n.attributes).length === 0), 'no element was given an attribute');
  const shown = nodes.map(text).join('\n');
  assert.ok(shown.includes('<script>alert(1)</script>'), shown);
  assert.ok(shown.includes('<img src=x onerror="alert(2)">'), shown);
  assert.ok(shown.includes('<a href="javascript:alert(3)">click</a>'), shown);
});

test('links keep their words, headings read bold, and a long summary is cut with an ellipsis', () => {
  assert.deepEqual(summaryBlocks('## Done\nSee [the PR](https://github.com/a/b/pull/1).'), [
    { kind: 'para', spans: [{ kind: 'strong', text: 'Done' }] },
    { kind: 'para', spans: [{ kind: 'text', text: 'See the PR.' }] },
  ]);
  const long = summaryBlocks(`${'word '.repeat(200)}`, 50);
  assert.equal(long.length, 1);
  const t = long[0].kind === 'para' ? long[0].spans.map((s) => s.text).join('') : '';
  assert.ok(t.length <= 50 && t.endsWith('…'), t);
  assert.deepEqual(summaryBlocks(''), []);
  assert.deepEqual(summaryBlocks(null), []);
});
