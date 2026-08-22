import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, detectTechnologies, resolveSameOriginLinks } from '../src/core/htmllite.js';

const HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Test Page</title>
  <meta charset="utf-8"/>
  <meta name="description" content="A page"/>
  <meta name="generator" content="WTEGen 1.0"/>
</head>
<body>
  <h1>Hello</h1>
  <a href="/internal">Internal</a>
  <a href="https://other.com/x">External</a>
  <a href="#">anchor</a>
  <img src="a.png"/>
  <img src="b.png" alt="b"/>
  <form method="post" action="/go">
    <label for="email">Email</label>
    <input type="text" id="email" name="email"/>
    <input type="text" name="nolabel"/>
    <input type="hidden" name="h"/>
  </form>
  <script src="jquery.min.js"></script>
</body>
</html>`;

describe('htmllite parser', () => {
  const page = parseHtml(HTML);

  it('extracts core document facts', () => {
    assert.equal(page.title, 'Test Page');
    assert.equal(page.lang, 'en');
    assert.equal(page.hasDoctype, true);
    assert.equal(page.headings.length, 1);
    assert.equal(page.headings[0]!.level, 1);
    assert.equal(page.scripts.count, 1);
    assert.equal(page.stylesheetCount, 0);
  });

  it('extracts meta tags', () => {
    assert.ok(page.meta.some((m) => m.name === 'description' && m.content === 'A page'));
    assert.ok(page.meta.some((m) => m.charset === 'utf-8'));
  });

  it('tracks images and alt presence', () => {
    assert.equal(page.images.length, 2);
    assert.equal(page.images.filter((i) => i.alt === null).length, 1);
  });

  it('associates form labels by for/id', () => {
    assert.equal(page.forms.length, 1);
    const inputs = page.forms[0]!.inputs;
    assert.equal(inputs.find((i) => i.name === 'email')!.hasLabel, true);
    assert.equal(inputs.find((i) => i.name === 'nolabel')!.hasLabel, false);
  });

  it('detects technologies from generator + scripts', () => {
    const tech = detectTechnologies(HTML);
    assert.ok(tech.includes('WTEGen 1.0'));
    assert.ok(tech.includes('jQuery'));
  });

  it('resolves same-origin links only, excluding anchors/mailto', () => {
    const links = resolveSameOriginLinks('https://example.com/base/page', page.links);
    assert.deepEqual(links.sort(), ['https://example.com/internal']);
  });
});
