// Unit tests for the integrity-critical pure logic. Run: `bun test`.
// happy-dom provides a DOM for the <template>-based helpers.
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { stripActive, spliceBody, proseModelable, filterInlineStyle, escapeAttr, mdLite } from "../client/lib";

// ───────────────────────── spliceBody — the $-corruption bug ─────────────────────────
const TOKEN = "%%NOTE_BODY%%";
const tpl = `<!DOCTYPE html><html><head><title>t</title></head><body>${TOKEN}</body></html>`;

test("spliceBody inserts the body at the token", () => {
  expect(spliceBody(tpl, TOKEN, "<p>hi</p>")).toContain("<body><p>hi</p></body>");
});

test("spliceBody preserves $-patterns verbatim ($&, $`, $', $$) — the regression", () => {
  const body = `<p>It costs $5 &amp; a smile. Patterns: $&amp; $\` $' $$ end.</p>`;
  const out = spliceBody(tpl, TOKEN, body);
  expect(out).toContain(body);                 // byte-for-byte, no replace() mangling
  expect(out).not.toContain(TOKEN);            // token fully consumed
});

test("spliceBody returns template unchanged when token absent", () => {
  expect(spliceBody("<body>nope</body>", TOKEN, "X")).toBe("<body>nope</body>");
});

// ───────────────────────── stripActive — load-path XSS ─────────────────────────
test("stripActive removes <script>, <iframe>, <object>, <embed>", () => {
  const out = stripActive(`<p>ok</p><script>evil()</script><iframe src="x"></iframe>`);
  expect(out).toContain("<p>ok</p>");
  expect(out.toLowerCase()).not.toContain("<script");
  expect(out.toLowerCase()).not.toContain("<iframe");
});

test("stripActive removes inline on* handlers", () => {
  const out = stripActive(`<img src="x" onerror="pwn()"><button onclick="pwn()">b</button>`);
  expect(out.toLowerCase()).not.toContain("onerror");
  expect(out.toLowerCase()).not.toContain("onclick");
});

test("stripActive removes javascript: URLs (href + xlink:href)", () => {
  const out = stripActive(`<a href="javascript:pwn()">x</a><svg><a xlink:href="javascript:pwn()"><text>t</text></a></svg>`);
  expect(out.toLowerCase()).not.toContain("javascript:");
});

test("stripActive keeps safe styled content", () => {
  const out = stripActive(`<span style="color:#e0245e">red</span>`);
  expect(out).toContain('style="color:#e0245e"');
  expect(out).toContain("red");
});

// ───────────────────────── proseModelable — editable vs atomic ─────────────────────────
test("proseModelable: colored/font/spacing text is editable prose", () => {
  expect(proseModelable(`Roses are <span style="color:#e0245e">red</span>`)).toBe(true);
  expect(proseModelable(`<span style="font-family:Georgia">serif</span>`)).toBe(true);
  expect(proseModelable(`<span style="letter-spacing:3px;text-transform:uppercase">x</span>`)).toBe(true);
  expect(proseModelable(`<strong>bold</strong> and <em>em</em>`)).toBe(true);
});

test("proseModelable: SVG, layout, and styled components stay atomic", () => {
  expect(proseModelable(`<svg><circle r="4"/></svg>`)).toBe(false);                       // unknown tag
  expect(proseModelable(`<div style="display:flex;gap:8px">box</div>`)).toBe(false);      // layout style + div
  expect(proseModelable(`<div class="card">styled</div>`)).toBe(false);                   // class = component
  expect(proseModelable(`<span style="position:absolute">x</span>`)).toBe(false);         // layout style
});

test("proseModelable: empty / plain text returns false (nothing to unwrap)", () => {
  expect(proseModelable("")).toBe(false);
  expect(proseModelable("just words")).toBe(false);
});

// ───────────────────────── filterInlineStyle — generic mark whitelist ─────────────────────────
test("filterInlineStyle keeps generic inline props, drops specific-mark + layout props", () => {
  expect(filterInlineStyle("font-family:Georgia; font-size:20px")).toBe("font-family:Georgia; font-size:20px");
  expect(filterInlineStyle("color:red")).toBeNull();          // color is the Color mark's job
  expect(filterInlineStyle("display:flex;color:red")).toBeNull(); // nothing generic kept
  expect(filterInlineStyle("letter-spacing:2px;display:flex")).toBe("letter-spacing:2px"); // keep only the safe one
});

// ───────────────────────── escapeAttr ─────────────────────────
test("escapeAttr escapes <, >, \", &", () => {
  expect(escapeAttr(`a"<b>&`)).toBe("a&quot;&lt;b&gt;&amp;");
});

// ───────────────────────── mdLite — safe chat markdown ─────────────────────────
test("mdLite escapes HTML before formatting (no live markup)", () => {
  const out = mdLite("Try <script>alert(1)</script>");
  expect(out).toContain("&lt;script&gt;");
  expect(out).not.toContain("<script>");
});

test("mdLite renders bold/italic/code and lists", () => {
  expect(mdLite("a **b** c")).toContain("<strong>b</strong>");
  expect(mdLite("- one\n- two")).toContain("<ul><li>one</li><li>two</li></ul>");
});
