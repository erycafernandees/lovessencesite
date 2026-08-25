#!/usr/bin/env python3
"""Static checks for the Love Essences commerce integration."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "index.html").read_text(encoding="utf-8")
seed = (ROOT / "supabase" / "seed.sql").read_text(encoding="utf-8")
migration = (ROOT / "supabase" / "migrations" / "202608210001_commerce.sql").read_text(encoding="utf-8")

required_files = [
    "assets/js/commerce.js", "assets/js/commerce-config.js", "admin/index.html", "admin/admin.js",
    "supabase/functions/checkout-prepare/index.ts", "supabase/functions/checkout-session/index.ts",
    "supabase/functions/stripe-webhook/index.ts", "supabase/functions/project-submit/index.ts",
    "supabase/functions/admin-api/index.ts", "_headers",
    "supabase/functions/quote-details/index.ts", "supabase/functions/quote-checkout/index.ts",
]
missing = [path for path in required_files if not (ROOT / path).exists()]
assert not missing, f"Missing commerce files: {missing}"

catalog_match = re.search(r"var PRODUCT_CATALOG = \{(.*?)\n\};\n\nvar currentProduct", source, re.S)
assert catalog_match, "Product catalog was not found"
catalog_codes = set(re.findall(r"^  ([a-z][a-z0-9_]+): \{", catalog_match.group(1), re.M))
seed_codes = set(re.findall(r"^\('([a-z][a-z0-9_]+)'", seed, re.M))
assert catalog_codes <= seed_codes, f"Products without server seed: {sorted(catalog_codes - seed_codes)}"

assert "Finalizar via WhatsApp" not in source
assert '<form id="contact-form" action=' not in source
assert 'id="pd-reference-files"' in source
assert 'name="inspiracoes"' in source
assert "allow_promotion_codes: true" in (ROOT / "supabase/functions/checkout-session/index.ts").read_text()
assert "payment_status public.payment_state" in migration
assert "order_status public.order_state" in migration
assert "public.is_admin" in migration
assert "private-references" in migration

print(f"Commerce validation passed: {len(catalog_codes)} catalog products, private uploads, Stripe checkout and admin controls present.")
