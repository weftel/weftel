// Unit tests for the integrity-critical pure logic. Run: `bun test`.
// happy-dom provides a DOM for the <template>-based helpers.
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { stripActive, spliceBody, proseModelable, editableModelable, subtreeEditable, scopeCss, filterInlineStyle, escapeAttr, mdLite, buildTree, countFiles, tidySaveHtml, isSvgTextLeaf, collectSvgTextLeaves } from "../../client/lib";

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

// ───────────────────────── editableModelable — the FULL_PARSE relax gate ─────────────────────────
test("editableModelable: strict (legacy) freezes any class", () => {
  expect(editableModelable(`<div class="card"><h3>x</h3></div>`)).toBe(false);
  expect(editableModelable(`<div style="padding:8px"><p>x</p></div>`)).toBe(true); // inline-style, no class → already editable
});

test("editableModelable: relaxClass=true makes class/<style>-driven content editable", () => {
  expect(editableModelable(`<div class="card"><h3>x</h3></div>`, true)).toBe(true);
  expect(editableModelable(`<strong class="t">x</strong>`, true)).toBe(true);
  expect(editableModelable(`<span class="fu">x</span>`, true)).toBe(true);
  expect(editableModelable(`<div class="wrap"><div class="sub">s</div><div class="card"><ul><li class="fu">a</li></ul></div></div>`, true)).toBe(true);
});

test("editableModelable: unmodelable elements still freeze even with relaxClass", () => {
  expect(editableModelable(`<svg><circle r="4"/></svg>`, true)).toBe(false);
  expect(editableModelable(`<div class="x"><iframe src="y"></iframe></div>`, true)).toBe(false);
  expect(editableModelable(`<div class="x"><canvas></canvas></div>`, true)).toBe(false);
  expect(editableModelable(`<div class="x"><img src="y"></div>`, true)).toBe(true); // img native now
  expect(editableModelable(`<figure><img src="y"><figcaption>c</figcaption></figure>`, true)).toBe(false); // figure not modeled → freeze whole (no silent tag-flatten)
});

test("proseModelable: relaxClass lets classed prose through", () => {
  expect(proseModelable(`<p class="lead">hi</p>`)).toBe(false);        // strict default
  expect(proseModelable(`<p class="lead">hi</p>`, true)).toBe(true);   // relaxed
});

// ───────────────────────── subtreeEditable — the isolation predicate ─────────────────────────
function el(html: string): Element { const t = document.createElement("template"); t.innerHTML = html; return t.content.firstElementChild as Element; }
test("subtreeEditable: text-only leaves are editable (unlike editableModelable)", () => {
  expect(subtreeEditable(el("<h1>Just a title</h1>"))).toBe(true);   // editableModelable would be false (no descendants)
  expect(subtreeEditable(el('<p class="lede">intro <strong>x</strong></p>'))).toBe(true);
  expect(subtreeEditable(el('<div class="card"><h3>t</h3><ul><li>a</li></ul></div>'))).toBe(true);
});
test("CLOSURE: the app's own task-list serialization is recognized as editable (label/input exempt)", () => {
  const taskUl = '<ul data-type="taskList"><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>';
  expect(subtreeEditable(el(taskUl))).toBe(true);                       // own dialect — trusted whole
  expect(editableModelable(taskUl, true)).toBe(true);                   // string gate too
  expect(editableModelable('<div class="x">' + taskUl + "<p>hi</p></div>", true)).toBe(true); // nested inside content
  expect(editableModelable('<label><input type="checkbox"></label>', true)).toBe(false);      // bare input OUTSIDE own dialect still freezes
});

test("subtreeEditable: any unmodelable descendant makes the whole subtree non-editable", () => {
  expect(subtreeEditable(el("<figure><svg><circle/></svg><figcaption>c</figcaption></figure>"))).toBe(false);
  expect(subtreeEditable(el('<div class="x"><p>ok</p><canvas></canvas></div>'))).toBe(false);
  expect(subtreeEditable(el("<svg><circle/></svg>"))).toBe(false);
  // img is NATIVE now (image node — paste support): no longer a freeze trigger
  expect(subtreeEditable(el('<div class="x"><p>ok</p><img src="y"></div>'))).toBe(true);
  expect(subtreeEditable(el('<img src="assets/x.png">'))).toBe(true);
});

// ───────────────────────── isSvgTextLeaf / collectSvgTextLeaves — SVG text editing (K1) ─────────────────────────
function svgEl(html: string): Element { const t = document.createElement("template"); t.innerHTML = html; return t.content.querySelector("svg")!.querySelector("*")!; }
test("isSvgTextLeaf: a <text>/<tspan> holding only text is an editable leaf", () => {
  expect(isSvgTextLeaf(svgEl('<svg><text x="0" y="10">Hello</text></svg>'))).toBe(true);
  const t = document.createElement("template"); t.innerHTML = '<svg><text><tspan>run</tspan></text></svg>';
  expect(isSvgTextLeaf(t.content.querySelector("tspan")!)).toBe(true);   // inner tspan is a leaf
  expect(isSvgTextLeaf(t.content.querySelector("text")!)).toBe(false);   // the wrapping <text> is a container
});
test("isSvgTextLeaf: empty/whitespace text and non-text elements are not leaves", () => {
  expect(isSvgTextLeaf(svgEl('<svg><text></text></svg>'))).toBe(false);          // empty
  expect(isSvgTextLeaf(svgEl('<svg><text>   </text></svg>'))).toBe(false);       // whitespace only
  expect(isSvgTextLeaf(svgEl('<svg><rect width="4" height="4"/></svg>'))).toBe(false); // not text/tspan
  expect(isSvgTextLeaf(svgEl('<svg><circle r="4"><title>label</title></circle></svg>'))).toBe(false);
});
test("collectSvgTextLeaves: gathers every editable run, skips containers + empties", () => {
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 100 60"><rect width="100" height="60"/><text x="5" y="20">one</text><text x="5" y="40"><tspan>two</tspan><tspan>three</tspan></text><text></text></svg>';
  const leaves = collectSvgTextLeaves(t.content).map((e) => e.textContent);
  expect(leaves).toEqual(["one", "two", "three"]); // the wrapping <text> and the empty one are excluded
});
test("collectSvgTextLeaves: pure-shape SVG yields no leaves (canary stays frozen); text reachable inside a frozen figure", () => {
  const count = (html: string) => { const t = document.createElement("template"); t.innerHTML = html; return collectSvgTextLeaves(t.content).length; };
  expect(count('<svg><text x="0" y="10">Label</text></svg>')).toBe(1);
  expect(count('<svg><circle cx="25" cy="25" r="20"/></svg>')).toBe(0);                         // no affordance for a pure-shape SVG
  expect(count('<figure><svg><text>cap</text></svg><figcaption>x</figcaption></figure>')).toBe(1); // text reachable even inside a frozen figure
});

// ───────────────────────── scopeCss — confine an imported sheet to the editor ─────────────────────────
const CHEAT_STYLE = `
  :root{--bg:#0b0c10;--accent:#7c7cf0;--radius:13px}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:#e8eaf0;font:16px/1.6 sans-serif}
  h1{font-size:30px;margin:0 0 6px}
  h2{font-size:12px;text-transform:uppercase;color:var(--accent)}
  .card{background:#13151c;border-radius:var(--radius);padding:14px 18px}
  .card h3{font-size:15px;color:#fff}
  .card li::marker{color:var(--accent)}
  .ask .fu{color:#9aa3b2;font-style:italic}
  strong.t{color:#bcc3ff;font-weight:700}
`;

test("scopeCss: :root/body map to the scope itself; * and bare/class selectors become descendants", () => {
  const out = scopeCss(CHEAT_STYLE, ".note-scope");
  expect(out).toContain(".note-scope{--bg:#0b0c10;--accent:#7c7cf0;--radius:13px}");
  expect(out).toContain(".note-scope *{box-sizing:border-box}");
  expect(out).toContain("color:#e8eaf0"); // body → .note-scope
  expect(out).toContain(".note-scope h2{");
  expect(out).toContain(".note-scope .card{");
  expect(out).toContain(".note-scope .card h3{");
  expect(out).toContain(".note-scope .card li::marker{");
  expect(out).toContain(".note-scope .ask .fu{");
  expect(out).toContain(".note-scope strong.t{");
  // chrome must never be matched: no bare body/:root/* selector survives unscoped
  expect(out).not.toMatch(/(^|})\s*(body|:root|\*)\s*{/);
});

test("scopeCss: comma lists scope each selector independently", () => {
  expect(scopeCss("h1,h2 .x{margin:0}", ".s")).toBe(".s h1,.s h2 .x{margin:0}");
  expect(scopeCss(":is(h1,h2){margin:0}", ".s")).toBe(".s :is(h1,h2){margin:0}"); // comma inside :is() not split
});

test("scopeCss: @media recurses, @keyframes/@font-face pass through verbatim", () => {
  const media = scopeCss("@media (max-width:600px){.card{padding:8px}body{margin:0}}", ".s");
  expect(media).toBe("@media (max-width:600px){.s .card{padding:8px}.s{margin:0}}");
  const kf = scopeCss("@keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}", ".s");
  expect(kf).toBe("@keyframes spin{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}"); // 0%/100% NOT prefixed
  expect(scopeCss("@import url(x.css);.card{x:1}", ".s")).toContain("@import url(x.css);");
});

test("scopeCss: :focus rules are dropped (page interaction styles ring the whole editor)", () => {
  expect(scopeCss(":focus-visible{outline:2px solid var(--accent)}.card{x:1}", ".s")).toBe(".s .card{x:1}");
  expect(scopeCss("a:focus,h1{margin:0}", ".s")).toBe(".s h1{margin:0}"); // only the :focus selector in the list drops
});

test("scopeCss: leading body combinator keeps the combinator", () => {
  expect(scopeCss("body > .x{margin:0}", ".s")).toBe(".s > .x{margin:0}");
  expect(scopeCss("body .x{margin:0}", ".s")).toBe(".s .x{margin:0}");
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

// ───────────────────────── buildTree / countFiles — sidebar folder tree ─────────────────────────
test("buildTree groups notes by their rel path into nested folders", () => {
  const notes = [
    { rel: "inbox.md" },
    { rel: "Projects/Alpha/spec.md" },
    { rel: "Projects/Alpha/notes.md" },
    { rel: "Projects/roadmap.md" },
    { rel: "Journal/2026-06-01.md" },
  ];
  const t = buildTree(notes);
  // root holds the one top-level file + two folders
  expect(t.files.map((f) => f.rel)).toEqual(["inbox.md"]);
  expect([...t.dirs.keys()].sort()).toEqual(["Journal", "Projects"]);
  // nested folder carries its full rel path (used as the collapse key)
  const projects = t.dirs.get("Projects")!;
  expect(projects.rel).toBe("Projects");
  expect(projects.files.map((f) => f.rel)).toEqual(["Projects/roadmap.md"]);
  const alpha = projects.dirs.get("Alpha")!;
  expect(alpha.rel).toBe("Projects/Alpha");
  expect(alpha.files.length).toBe(2);
});

test("countFiles totals notes recursively, not just direct children", () => {
  const t = buildTree([
    { rel: "Projects/Alpha/spec.md" },
    { rel: "Projects/Alpha/notes.md" },
    { rel: "Projects/roadmap.md" },
  ]);
  expect(countFiles(t.dirs.get("Projects")!)).toBe(3); // 1 direct + 2 nested
});

test("buildTree on a flat vault yields no folders", () => {
  const t = buildTree([{ rel: "a.md" }, { rel: "b.html" }]);
  expect(t.dirs.size).toBe(0);
  expect(t.files.length).toBe(2);
});

// ---- tidySaveHtml: strip PM table scaffolding from saves, keep user-set widths ----
test("tidySaveHtml strips colspan/rowspan=1, min-width colgroup, table min-width, cell <p>", () => {
  const dirty = '<table class="kv" style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="1" rowspan="1"><p>a</p></td><td colspan="1" rowspan="1"><p>has <code>c</code></p></td></tr></tbody></table>';
  const out = tidySaveHtml(dirty);
  expect(out).toBe('<table class="kv"><tbody><tr><td>a</td><td>has <code>c</code></td></tr></tbody></table>');
});

test("tidySaveHtml keeps real colspans, real column widths, and multi-block cells", () => {
  const html = '<table><colgroup><col style="width: 120px;"><col style="min-width: 25px;"></colgroup><tbody><tr><td colspan="2"><p>one</p><p>two</p></td></tr></tbody></table>';
  const out = tidySaveHtml(html);
  expect(out).toContain('colspan="2"');
  expect(out).toContain('width: 120px');          // a genuine resize survives
  expect(out).toContain("<p>one</p><p>two</p>");  // multi-paragraph cell keeps its <p>s
});

test("tidySaveHtml leaves classed/styled cell paragraphs alone", () => {
  const html = '<table><tbody><tr><td><p class="x">styled</p></td></tr></tbody></table>';
  expect(tidySaveHtml(html)).toContain('<p class="x">styled</p>');
});
