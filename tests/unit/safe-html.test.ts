// [AI:cmdk] Regression for the SVG-fidelity bug a human dogfood caught: a generative ⌘K returned a
// broken SVG because sanitize-html lowercased camelCase names (linearGradient→lineargradient,
// viewBox→viewbox) BEFORE the (camelCase) allowlist matched them, so they were dropped — gradients
// died and the viewBox was lost, clipping the diagram. safeRichHtml must now preserve them.
import { test, expect } from "bun:test";
import { safeRichHtml } from "../../safe-html";

const SVG = `<svg viewBox="0 0 800 500" width="100%" style="border:1px solid #ccc"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#87CEEB"/><stop offset="100%" stop-color="#E0F6FF"/></linearGradient><radialGradient id="sun"><stop offset="0%" stop-color="#ffd93d"/></radialGradient><clipPath id="c"><rect width="10" height="10"/></clipPath></defs><rect width="800" height="500" fill="url(#sky)"/><circle cx="100" cy="80" r="40" fill="url(#sun)"/></svg>`;

test("safeRichHtml preserves camelCase SVG element names (was dropped → dead gradients)", () => {
  const out = safeRichHtml(SVG);
  expect(out).toContain("<linearGradient");
  expect(out).toContain("<radialGradient");
  expect(out).toContain("<clipPath");
  expect(out).not.toContain("lineargradient");           // not lowercased/dropped
});

test("safeRichHtml preserves camelCase SVG attributes (viewBox/gradientUnits → sizing + fills)", () => {
  const out = safeRichHtml(SVG);
  expect(out).toContain('viewBox="0 0 800 500"');        // the sizing attr — its loss caused the clip
  expect(out).toContain('gradientUnits="userSpaceOnUse"');
  expect(out).toContain('width="100%"');
  // the gradient referenced by fill="url(#sky)" still EXISTS (the wrapper survived)
  expect(out).toContain('id="sky"');
  expect(out).toContain('fill="url(#sky)"');
});

test("safeRichHtml still strips XSS vectors (case-preservation didn't weaken sanitize)", () => {
  const out = safeRichHtml(`<svg onload="alert(1)"><script>evil()</script><rect onclick="x"/></svg><a href="javascript:x()">j</a>`);
  expect(out.toLowerCase()).not.toContain("onload");
  expect(out.toLowerCase()).not.toContain("<script");
  expect(out.toLowerCase()).not.toContain("onclick");
  expect(out.toLowerCase()).not.toContain("javascript:");
});

test("safeRichHtml keeps normal lowercase HTML intact", () => {
  const out = safeRichHtml(`<p class="x">hi <strong>bold</strong> <em>i</em></p><table><tr><th>A</th><td>b</td></tr></table>`);
  expect(out).toContain("<strong>bold</strong>");
  expect(out).toContain("<em>i</em>");
  expect(out).toContain('class="x"');
  expect(out).toContain("<table>");
});
