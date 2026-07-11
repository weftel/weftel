# Gate-O evidence — live walkthrough transcript (2026-07-10)

A **real `claude -p` agent** in a fenced test vault carrying `examples/vault-settings.json`
(deny rules) + `examples/mcp.json` (this MCP server), against a running weftel server with
the note open in a real (headless Chromium) tab whose human side auto-approved the gate.
Reproduce: the script pattern lives in the phase-2 session notes; the moving parts are
exactly the README setup steps.

## A · direct Edit — DENIED (enforcement works)

> **prompt:** Open note.html and change the heading "Quarterly report" to "Q3 report" by
> DIRECTLY editing the file with the Edit tool. Do not use any MCP tools.

> **agent:** The edit is blocked. The Edit tool returned this error:
> "File is in a directory that is denied by your permission settings."
> The directory containing note.html is on a deny list in your permission settings, so
> direct file edits there are refused. As instructed, I'm stopping here without attempting
> any workaround or MCP tools.

File on disk after A: unchanged.

## B · through the weftel tools — gated, approved, saved

> **prompt:** Using ONLY the weftel MCP tools, retitle the "Quarterly report" heading in
> note.html to "Q3 2026 report". Report the tool results you got.

> **agent:** Done. The heading is now "Q3 2026 report".
> Tool results:
> - `weftel_read_doc` returned the outline at docVersion `2ol5hj9ly6nme` with two blocks:
>   the heading `sec-1` ("Quarterly report", an author id) and paragraph `w-2tdh`.
> - `weftel_set_text` on `sec-1` with the expected version returned
>   `ok: true, state: "approved"` — you approved the diff in the weftel tab, and it saved
>   as new docVersion `2ftztls0hv16n`.

## Outcome (asserted by the harness)

- gate rendered in the open tab and was approved: **yes**
- saved bytes contain `Q3 2026 report`: **yes**
- author id `sec-1` survived: **yes**

The playbook's phase gate — *the walkthrough works on one real case* — holds with a real
agent, real enforcement, a real tab, and real bytes. (Mechanical CI equivalent:
`tests/e2e/mcp-tracer.spec.ts`.)
