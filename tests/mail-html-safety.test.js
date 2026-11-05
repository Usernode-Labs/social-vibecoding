'use strict';

// src/services/mail/html-safety.js: the gate an admin's email HTML passes
// before it is stored. It only refuses; nothing is rewritten.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEmailHtml, scanHtml, MAX_EMAIL_HTML_BYTES } = require('../src/services/mail/html-safety');

const refused = (html, pattern) => {
  const result = validateEmailHtml(html);
  assert.equal(result.ok, false, `expected a refusal for ${html.slice(0, 80)}`);
  assert.equal(typeof result.reason, 'string');
  if (pattern) assert.match(result.reason, pattern);
};
const allowed = (html) => assert.deepEqual(validateEmailHtml(html), { ok: true }, html.slice(0, 80));

test('ordinary email HTML passes, conditional comments and styles included', () => {
  allowed('<p style="margin:0;color:#111">Hello <strong>there</strong></p>');
  allowed('<table role="presentation" width="100%"><tr><td><a href="https://example.com/x?a=1&amp;b=2">Go</a></td></tr></table>');
  allowed('<img src="https://my.onhomeroom.com/logo.png" alt="Homeroom" width="40">');
  allowed('<!DOCTYPE html><html><head><style>p { color: red; } @media (max-width:600px){ td{display:block} }</style></head><body>x</body></html>');
  allowed('<!--[if mso]><table><tr><td><![endif]--><p>x</p><!--[if mso]></td></tr></table><![endif]-->');
  allowed('<a href="mailto:hello@example.com">Mail us</a> <a href="{{url}}">Open</a>');
  allowed('Plain words with a < b and {{code}}');
});

test('blocked elements are refused, whatever their case', () => {
  for (const name of ['script', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base']) {
    refused(`<p>x</p><${name}>`, new RegExp(name));
    refused(`<${name.toUpperCase()} x="1">`, new RegExp(name));
  }
  refused('<script/src="https://evil.example/x.js"></script>', /script/);
  refused('<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', /svg/);
  refused('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>');
});

test('event handler attributes are refused in any case', () => {
  refused('<p onclick="alert(1)">x</p>', /onclick/);
  refused('<p ONCLICK="alert(1)">x</p>', /onclick/i);
  refused('<img src="https://x.example/a.png" onerror=alert(1)>', /onerror/);
  refused('<a href="https://x.example" OnMouseOver = \'x\'>a</a>');
  refused('<p\nonload="x">');
  refused('<p/onload="x">');
});

test('script and data URLs are refused, however they are spelled', () => {
  refused('<a href="javascript:alert(1)">x</a>', /script or data/);
  refused('<a href="JavaScript:alert(1)">x</a>');
  refused('<a href="java&#115;cript:alert(1)">x</a>');
  refused('<a href="java&#x73;cript:alert(1)">x</a>');
  refused('<a href="java&#115cript:alert(1)">x</a>');
  refused('<a href="javascript&colon;alert(1)">x</a>');
  refused('<a href="  java\tscript:alert(1)">x</a>');
  refused('<a href="java&Tab;script:alert(1)">x</a>');
  refused('<a href=javascript:alert(1)>x</a>');
  refused('<a href="vbscript:x">x</a>');
  refused('<img src="data:image/png;base64,AAAA">');
  refused('<img src=" DATA:text/html,x">');
  refused('<a href="java{{url}}script:alert(1)">x</a>', /script or data/);
  refused('<td background="javascript:x">');
});

test('external stylesheets and script in CSS are refused', () => {
  refused('<style>@import url(https://evil.example/x.css);</style>', /@import/);
  refused('<style>@IMPORT "https://evil.example/x.css";</style>', /@import/);
  refused('<style>@\\69mport "https://evil.example/x.css";</style>', /@import/);
  refused('<p style="background:url(javascript:alert(1))">x</p>');
  refused('<p style="width:expression(alert(1))">x</p>');
  refused('<p style="background:url(data:image/png;base64,AAAA)">x</p>');
  refused('<div style="background:url(&#106;avascript:x)">');
});

test('comments cannot hide a tag from the check', () => {
  refused('<!--><script>alert(1)</script>-->');
  refused('<!---><script>alert(1)</script>-->');
  refused('<!-- x --!><script>alert(1)</script>-->');
  refused('<!--[if mso]><script>alert(1)</script><![endif]-->');
  refused('<!-- never closed <p>x</p>');
});

test('malformed or oversized documents are refused', () => {
  refused('<a href="https://x.example>never closed', /ends/);
  refused('<p class="x"', /ends/);
  refused('<p>\u0000</p>');
  const big = '<p>' + 'x'.repeat(MAX_EMAIL_HTML_BYTES) + '</p>';
  refused(big, /100 KB/);
  allowed('<p>' + 'x'.repeat(MAX_EMAIL_HTML_BYTES - 10) + '</p>');
  assert.equal(validateEmailHtml(null).ok, false);
});

test('scanHtml reports tags, quoted attribute value spans and style blocks by offset', () => {
  const src = '<p>a</p><a class=x href="{{url}}">b</a><style>p{}</style>';
  const scan = scanHtml(src);
  assert.equal(scan.ok, true);
  const a = scan.tags.find((tag) => tag.name === 'a');
  assert.equal(src.slice(a.start, a.end), '<a class=x href="{{url}}">');
  const href = a.attributes.find((attr) => attr.name === 'href');
  assert.equal(href.quote, '"');
  assert.equal(src.slice(href.valueStart, href.valueEnd), '{{url}}');
  assert.equal(a.attributes.find((attr) => attr.name === 'class').quote, '');
  const style = scan.rawTexts.find((block) => block.name === 'style');
  assert.equal(src.slice(style.start, style.end), 'p{}');
});

test('numeric references are decoded however many digits they have, leading zeros included', () => {
  refused('<a href="&#0000000106;avascript:alert(1)">x</a>', /script or data/);
  refused('<a href="&#x000000000006A;avascript:alert(1)">x</a>', /script or data/);
  refused('<a href="java&#0000000000000115cript:alert(1)">x</a>', /script or data/);
  refused('<p style="background:url(&#00000000106;avascript:x)">x</p>');
  refused('<p style="background:url(&#X0000000006a;avascript:x)">x</p>');
  allowed('<a href="https://example.com/&#99999999999999;">x</a>');
});
