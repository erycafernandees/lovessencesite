import sys
import fnmatch
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from browser_security import Externalize, CheckPolicy, secure_documents
from hosting_security import browser_policy, host_headers


def effective_headers(path):
    """Cloudflare's documented ordered matching, detach and comma-join rules."""
    result = {}
    active = False
    for line in host_headers().splitlines():
        if not line or line.startswith('#'):
            continue
        if not line.startswith(' '):
            active = fnmatch.fnmatchcase(path, line)
        elif active:
            entry = line.strip()
            if entry.startswith('! '):
                result.pop(entry[2:].lower(), None)
            else:
                name, value = entry.split(':', 1)
                key = name.lower()
                result[key] = result[key] + ', ' + value.strip() if key in result else value.strip()
    return result


class SecurityBuildTests(unittest.TestCase):
    def test_externalizes_head_and_module_scripts_but_preserves_structured_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = '<html><head><script>window.headWorks=true;</script><script type="application/ld+json">{"name":"A"}</script></head><body><button onclick="capture(this, event); return false;">A</button><script type="module">const n=1;</script></body></html>'
            page = root / "index.html"
            page.write_text(source)
            secure_documents(root)
            result = page.read_text()
            self.assertNotIn(' onclick=', result)
            self.assertIn('data-le-onclick=', result)
            self.assertIn('type="application/ld+json">{"name":"A"}', result)
            self.assertIn('type="module" src=', result)
            scripts = [p.read_text() for p in (root / "assets/js").glob("*.js")]
            self.assertIn('window.headWorks=true;', scripts)
            self.assertTrue(any('capture(this, event); return false;' in script for script in scripts))
            self.assertTrue(all('__LOVE_EVENT_HANDLERS__' not in script for script in scripts))

    def test_handler_entities_are_decoded_once_and_product_ids_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "assets/js").mkdir(parents=True)
            handlers = {}
            parser = Externalize('<a onclick="openProduct(&quot;bloom&quot;); return false;">Bloom</a>', root, handlers)
            parser.feed(parser.source)
            self.assertIn('data-le-product="bloom"', parser.result())
            self.assertEqual(next(iter(handlers.values()))[1], 'openProduct("bloom"); return false;')

    def test_validator_rejects_runtime_handler_script_and_javascript_url(self):
        parser = CheckPolicy()
        parser.feed('<button onclick="attack()">A</button><script>attack()</script><a href="java&#10;script:attack()">B</a>')
        self.assertIn('inline event attribute: onclick', parser.errors)
        self.assertIn('inline executable script', parser.errors)
        self.assertIn('javascript: URL', parser.errors)

    def test_host_policy_matches_html_and_admin_sdk_is_not_blocked_by_overlap(self):
        for path, admin in [('/', False), ('/produtos/rumo/', False), ('/admin', True), ('/admin/', True), ('/admin/index.html', True)]:
            headers = effective_headers(path)
            policy = headers['content-security-policy']
            self.assertEqual(policy, browser_policy(admin) + "; frame-ancestors 'none'; upgrade-insecure-requests")
            scripts = next(part for part in policy.split('; ') if part.startswith('script-src '))
            self.assertNotIn('unsafe-inline', scripts)
            self.assertNotIn('unsafe-eval', scripts)
            self.assertEqual('https://cdn.jsdelivr.net' in scripts, admin)
            self.assertIn("frame-src 'self' https://challenges.cloudflare.com", policy)
            self.assertEqual(headers['x-frame-options'], 'DENY')
            self.assertEqual(headers['x-content-type-options'], 'nosniff')
            self.assertEqual(headers['referrer-policy'], 'no-referrer')

    def test_sensitive_routes_have_no_store_and_assets_must_revalidate(self):
        for path in ['/admin', '/admin/', '/admin/admin.js', '/checkout', '/checkout/', '/encomenda/confirmacao/', '/orcamento/abc', '/avaliar/token']:
            self.assertEqual(effective_headers(path)['cache-control'], 'no-store', path)
        self.assertEqual(effective_headers('/assets/js/commerce.js')['cache-control'], 'public, max-age=0, must-revalidate')
        self.assertEqual(effective_headers('/')['strict-transport-security'], 'max-age=31536000')

    def test_header_lines_fit_cloudflare_limits(self):
        self.assertTrue(all(len(line) <= 2000 for line in host_headers().splitlines()))


if __name__ == '__main__':
    unittest.main()
