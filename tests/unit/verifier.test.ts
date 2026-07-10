// Unit tests for the verifier's own logic: contrast math against known WCAG vectors,
// the ids survival diff, and xfail/xpass accounting. Run: `bun test tests/unit`.
import { test, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as any).document === "undefined") GlobalRegistrator.register();

import { parseColor, contrastRatio, over, substVars, parseSheets, customProps } from "../../verifier/checks/css";
import { checkIds } from "../../verifier/checks/ids";
import { applyExpectations, buildReport } from "../../verifier/report";

// ---- contrast math: known WCAG vectors ----
test("contrast: black on white = 21, white on white = 1", () => {
  const black = parseColor("#000")!, white = parseColor("#fff")!;
  expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
  expect(contrastRatio(white, white)).toBeCloseTo(1, 3);
});
test("contrast: #777 on white ≈ 4.48 (the classic just-below-AA gray)", () => {
  expect(contrastRatio(parseColor("#777")!, parseColor("#fff")!)).toBeCloseTo(4.48, 1);
});
test("parseColor handles hex/rgb/rgba/hsl/named; rejects color-mix", () => {
  expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  expect(parseColor("rgba(0,0,0,.5)")!.a).toBeCloseTo(0.5, 5);
  expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  expect(parseColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
});
test("alpha compositing: 50% black over white = mid gray", () => {
  const c = over({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  expect(c.r).toBe(128);
  expect(c.a).toBe(1);
});
test("var substitution: one level + fallback; unresolved → null", () => {
  const rules = parseSheets([":root{--ink:#222} p{color:var(--ink)}"]);
  const vars = customProps(rules);
  expect(substVars("var(--ink)", vars)).toBe("#222");
  expect(substVars("var(--missing, #333)", vars)).toBe("#333");
  expect(substVars("var(--missing)", vars)).toBeNull();
});

// ---- ids survival diff ----
const DOC = (body: string) => `<!DOCTYPE html><html><head><title>t</title></head><body>${body}</body></html>`;
test("ids: loss detected and classified; deletes exempt; anchors flagged", () => {
  const before = DOC('<h2 id="a">One</h2><p id="b">Two</p><a href="#a">go</a>');
  const afterLoss = DOC('<h2>One</h2><p id="b">Two</p><a href="#a">go</a>');
  const r = checkIds("f", before, afterLoss);
  expect(r[0].state).toBe("fail");
  expect(r[0].detail).toContain("a");
  expect(r[0].detail).toContain("broken-anchor");
  const rDel = checkIds("f", before, afterLoss, ["a"]);
  expect(rDel[0].state).toBe("pass");
  const rSame = checkIds("f", before, before);
  expect(rSame[0].state).toBe("pass");
});
test("ids: author data-* loss detected, app hooks ignored", () => {
  const before = DOC('<div data-sbox="" data-p="1"><p>x</p></div>');
  const after = DOC('<div><p>x</p></div>');
  const r = checkIds("f", before, after);
  expect(r[0].state).toBe("fail");
  expect(r[0].detail).toContain("data-p=1");
  expect(r[0].detail).not.toContain("data-sbox");
});

// ---- xfail/xpass accounting ----
test("expectations: pinned fail → xfail (exit 0); pinned pass → xpass (exit 1); unpinned fail → exit 1", () => {
  const pins = [{ file: "x.html", check: "ids" as const, reason: "known" }];
  const xfail = applyExpectations([{ file: "x.html", check: "ids", state: "fail" }], pins);
  expect(xfail[0].state).toBe("xfail");
  expect(buildReport(xfail, 1, "c").exitCode).toBe(0);
  const xpass = applyExpectations([{ file: "x.html", check: "ids", state: "pass" }], pins);
  expect(xpass[0].state).toBe("xpass");
  expect(buildReport(xpass, 1, "c").exitCode).toBe(1);
  expect(buildReport([{ file: "y.html", check: "ids", state: "fail" }], 1, "c").exitCode).toBe(1);
});
test("advisory fails never gate; errors exit 2", () => {
  expect(buildReport([{ file: "z.html", check: "contrast", state: "fail", advisory: true }], 1, "c").exitCode).toBe(0);
  expect(buildReport([{ file: "z.html", check: "roundtrip", state: "error" }], 1, "c").exitCode).toBe(2);
});
