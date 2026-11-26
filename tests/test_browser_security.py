import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from browser_security import Externalize, CheckPolicy, secure_documents


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


if __name__ == '__main__':
    unittest.main()
