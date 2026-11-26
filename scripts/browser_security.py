"""Move trusted, versioned page code to external files before adding CSP.

Handlers are compiled at build time. Runtime HTML supplies only an identifier
looked up in a fixed function map; it cannot supply executable JavaScript.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
from html.parser import HTMLParser
from pathlib import Path

EVENT = re.compile(r'''\s(on[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))''', re.I)
PRODUCT = re.compile(r'''^\s*openProduct\(['"]([a-z0-9_]+)['"]\)''')
JS_TYPES = {"", "text/javascript", "application/javascript", "module"}


class Externalize(HTMLParser):
    def __init__(self, source: str, output: Path, handlers: dict[str, tuple[str, str]]):
        super().__init__(convert_charrefs=False)
        self.source, self.output, self.handlers = source, output, handlers
        self.offsets = [0]
        self.offsets.extend(match.end() for match in re.finditer("\n", source))
        self.edits: list[tuple[int, int, str]] = []
        self.script: tuple[int, int, str] | None = None

    def position(self) -> int:
        line, col = self.getpos()
        return self.offsets[line - 1] + col

    def handle_starttag(self, tag, attrs):
        start = self.position()
        raw = self.get_starttag_text()
        attributes = dict(attrs)

        def event(match):
            name = match.group(1).lower()[2:]
            body = html.unescape(next(value for value in match.groups()[1:] if value is not None))
            key = hashlib.sha256((name + "\0" + body).encode()).hexdigest()[:20]
            existing = self.handlers.setdefault(key, (name, body))
            if existing != (name, body):
                raise ValueError("Event identifier collision")
            product = PRODUCT.match(body)
            product_attr = f' data-le-product="{product.group(1)}"' if product and "data-le-product" not in attributes else ""
            return f' data-le-on{name}="{key}"{product_attr}'

        replaced = EVENT.sub(event, raw)
        if replaced != raw:
            self.edits.append((start, start + len(raw), replaced))
        if tag == "script" and "src" not in attributes and (attributes.get("type") or "").lower() in JS_TYPES:
            self.script = (start, start + len(raw), replaced)

    handle_startendtag = handle_starttag

    def handle_endtag(self, tag):
        if tag != "script" or self.script is None:
            return
        start, body_start, opening = self.script
        body_end = self.position()
        end = self.source.index(">", body_end) + 1
        body = self.source[body_start:body_end]
        filename = "page-script-" + hashlib.sha256(body.encode()).hexdigest()[:20] + ".js"
        path = self.output / "assets" / "js" / filename
        path.write_text(body, encoding="utf-8")
        self.edits = [edit for edit in self.edits if edit[0] != start]
        opening = opening[:-1] + f' src="/assets/js/{filename}">'
        self.edits.append((start, end, opening + "</script>"))
        self.script = None

    def result(self) -> str:
        source = self.source
        for start, end, replacement in sorted(self.edits, reverse=True):
            source = source[:start] + replacement + source[end:]
        return source


def secure_documents(output: Path) -> None:
    (output / "assets/js").mkdir(parents=True, exist_ok=True)
    handlers: dict[str, tuple[str, str]] = {}
    pages = sorted(output.rglob("*.html"))
    for page in pages:
        parser = Externalize(page.read_text(encoding="utf-8"), output, handlers)
        parser.feed(parser.source)
        parser.close()
        page.write_text(parser.result(), encoding="utf-8")
    entries = []
    for key, (event, body) in sorted(handlers.items()):
        entries.append(json.dumps(key) + ': { event: ' + json.dumps(event) + ', handle: function(event) {\n' + body + '\n} }')
    template = Path(__file__).with_name("public-events.js").read_text(encoding="utf-8")
    runtime = template.replace("__LOVE_EVENT_HANDLERS__", "{\n" + ",\n".join(entries) + "\n}")
    filename = "page-events-" + hashlib.sha256(runtime.encode()).hexdigest()[:20] + ".js"
    (output / "assets/js" / filename).write_text(runtime, encoding="utf-8")
    for page in pages:
        source = page.read_text(encoding="utf-8")
        if "data-le-on" in source:
            source = source.replace("</body>", f'<script src="/assets/js/{filename}"></script>\n</body>', 1)
        page.write_text(source, encoding="utf-8")


class CheckPolicy(HTMLParser):
    def __init__(self):
        super().__init__()
        self.policy = None
        self.script_type = None
        self.errors = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "meta" and attributes.get("http-equiv", "").lower() == "content-security-policy":
            if self.policy is not None:
                self.errors.append("duplicate CSP")
            self.policy = attributes.get("content", "")
        for key, value in attrs:
            if key.lower().startswith("on"):
                self.errors.append("inline event attribute: " + key)
            if key in {"href", "src", "action", "formaction"} and value and re.sub(r"[\x00-\x20]", "", value).lower().startswith("javascript:"):
                self.errors.append("javascript: URL")
        if tag == "script":
            self.script_type = (attributes.get("type") or "").lower() if "src" not in attributes else None

    handle_startendtag = handle_starttag

    def handle_data(self, data):
        if self.script_type in JS_TYPES and data.strip():
            self.errors.append("inline executable script")

    def handle_endtag(self, tag):
        if tag == "script":
            self.script_type = None


def validate_documents(output: Path) -> None:
    for page in output.rglob("*.html"):
        parser = CheckPolicy()
        parser.feed(page.read_text(encoding="utf-8"))
        directives = dict((parts[0], parts[1:]) for part in (parser.policy or "").split(";") if (parts := part.split()))
        scripts = directives.get("script-src", [])
        if not scripts or any(item in scripts for item in ("'unsafe-inline'", "'unsafe-eval'")):
            parser.errors.append("missing or permissive script-src")
        if directives.get("script-src-attr") != ["'none'"]:
            parser.errors.append("script-src-attr must be none")
        if parser.errors:
            raise ValueError(str(page.relative_to(output)) + ": " + ", ".join(parser.errors))
    # Dynamic HTML must also use identifiers instead of rebuilding onclick
    # attributes inside the external application script.
    dynamic_handler = re.compile(r'''(?<![\w.-])on(?:click|change|submit|input|error|load|keydown|keyup|mouseover)\s*=\s*["']''', re.I)
    for script in (output / "assets/js").glob("*.js"):
        if dynamic_handler.search(script.read_text(encoding="utf-8")):
            raise ValueError(str(script.relative_to(output)) + ": inline handler in dynamic HTML")
