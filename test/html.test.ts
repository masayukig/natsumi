import assert from 'node:assert/strict';
import test from 'node:test';
import { html, Html } from '../src/server/html.ts';

test('every value put into a template is escaped, in text and in quoted attributes alike', () => {
  const hostile = `<script>alert("x")</script>&'`;
  const page = html`<p title="${hostile}">${hostile}</p>`;
  assert.ok(page instanceof Html);
  assert.equal(page.text,
    '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;</p>');
});

test('a template put into another is kept as markup and not escaped twice', () => {
  const inner = html`<b>${'a & b'}</b>`;
  assert.equal(html`<p>${inner}</p>`.text, '<p><b>a &amp; b</b></p>');
});

test('lists are joined item by item, each escaped unless it is a template', () => {
  const items = ['<i>', html`<li>${'&'}</li>`, 3];
  assert.equal(html`<ul>${items}</ul>`.text, '<ul>&lt;i&gt;<li>&amp;</li>3</ul>');
});

test('nothing is written for null, undefined and false, so a condition can stand in a template', () => {
  const shown = false;
  assert.equal(html`<p>${null}${undefined}${shown && html`<b>x</b>`}</p>`.text, '<p></p>');
  assert.equal(html`<p>${0}</p>`.text, '<p>0</p>');
});

test('an object that only looks like a template is escaped as text: markup is made by the tag alone', () => {
  const forged = { text: '<b>forged</b>' } as unknown as Html;
  assert.ok(!html`${forged}`.text.includes('<b>'));
  const lookalike = Object.defineProperty(Object.create(Html.prototype) as object, 'text', { value: '<b>forged</b>' }) as Html;
  assert.ok(!html`${lookalike}`.text.includes('<b>'), 'a copy of the prototype is not a template either');
});
