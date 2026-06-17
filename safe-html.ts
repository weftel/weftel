// [AI:cmdk] Calibrated sanitize for AI (⌘K) rich-HTML output: keep the design (classes, inline
// styles, SVG) but strip the real execution vectors (script/iframe/object, on* handlers,
// javascript: URLs). Extracted from server.ts so it's unit-testable WITHOUT booting Bun.serve
// (the client bundle never imports this — sanitize-html stays server-only).
//
// SVG FIDELITY (the dogfood bug): sanitize-html's parser (htmlparser2) defaults to LOWERCASING tag
// and attribute names. That turned an AI's valid `<linearGradient viewBox gradientUnits>` into
// `lineargradient`/`viewbox`/`gradientunits`, which then failed our (camelCase) allowlist and were
// DROPPED — killing gradients and the viewBox, so the SVG rendered clipped with dead url(#…) fills.
// Disabling lowercasing preserves camelCase SVG names end-to-end so the allowlist matches them and
// the browser renders them correctly. Trade-off: an UPPERCASE HTML tag (e.g. `<P>`) would no longer
// match the lowercase allowlist and would be unwrapped — models emit lowercase HTML, and the text
// content is preserved, so this is acceptable for the SVG-fidelity win.
import sanitizeHtml from "sanitize-html";

export const SVG_ATTRS = ["viewBox","preserveAspectRatio","xmlns","xmlns:xlink","d","fill","fill-opacity","fill-rule","stroke","stroke-width","stroke-linecap","stroke-linejoin","stroke-dasharray","x","y","x1","y1","x2","y2","cx","cy","r","rx","ry","width","height","points","transform","offset","stop-color","stop-opacity","gradientUnits","gradientTransform","spreadMethod","text-anchor","dominant-baseline","font-size","font-family","font-weight","opacity","marker-end","marker-start","clip-path","clipPathUnits","mask","markerWidth","markerHeight","refX","refY","markerUnits","patternUnits","patternContentUnits","patternTransform"];

export function safeRichHtml(html: string): string {
  return sanitizeHtml(html, {
    // Preserve case so camelCase SVG names (linearGradient, viewBox, gradientUnits…) survive the
    // allowlist instead of being lowercased-then-dropped. (htmlparser2 lowercases by default.)
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowedTags: [
      "div","span","p","section","article","header","footer","main","aside","nav",
      "h1","h2","h3","h4","h5","h6","ul","ol","li","dl","dt","dd",
      "table","thead","tbody","tfoot","tr","td","th","caption","colgroup","col",
      "figure","figcaption","img","picture","blockquote","pre","code","kbd","samp","var",
      "strong","em","b","i","u","s","sub","sup","mark","small","hr","br","wbr",
      "details","summary","time","abbr","cite","q","label","meter","progress",
      "svg","g","path","circle","ellipse","rect","line","polyline","polygon","text","tspan",
      "defs","linearGradient","radialGradient","stop","clipPath","use","symbol","marker","pattern","mask","title","desc",
    ],
    allowedAttributes: {
      "*": ["class", "id", "style", "title", "role", "data-*", "aria-*"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height", "loading"],
      svg: SVG_ATTRS, g: SVG_ATTRS, path: SVG_ATTRS, circle: SVG_ATTRS, ellipse: SVG_ATTRS,
      rect: SVG_ATTRS, line: SVG_ATTRS, polyline: SVG_ATTRS, polygon: SVG_ATTRS, text: SVG_ATTRS,
      tspan: SVG_ATTRS, stop: SVG_ATTRS, linearGradient: SVG_ATTRS, radialGradient: SVG_ATTRS,
      use: SVG_ATTRS, clipPath: SVG_ATTRS, marker: SVG_ATTRS, pattern: SVG_ATTRS, mask: SVG_ATTRS, defs: SVG_ATTRS,
    },
    allowedSchemes: ["http", "https", "data", "mailto"],
    allowVulnerableTags: false,
  });
}
