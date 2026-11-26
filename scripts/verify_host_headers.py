#!/usr/bin/env python3
"""Read-only verification of HTTP security headers on a deployed static site."""

import argparse
import json
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from hosting_security import browser_policy


def verify(base_url):
    target = urlparse(base_url)
    if target.scheme != 'https' or not target.hostname or target.username or target.password or target.path not in ('', '/') or target.query or target.fragment:
        raise ValueError('Usa apenas a origem HTTPS do alojamento, sem credenciais, caminho ou parâmetros.')
    results = []
    for path, admin, private in [('/', False, False), ('/admin/', True, True), ('/checkout/', False, True), ('/encomenda/confirmacao/', False, True)]:
        checks = {}
        try:
            with urlopen(Request(base_url.rstrip('/') + path, headers={'User-Agent': 'LoveEssences-HeaderCheck/1.0'}), timeout=20) as response:
                headers = response.headers
                checks['https_same_host'] = urlparse(response.url).scheme == 'https' and urlparse(response.url).hostname == target.hostname
                checks['status_200'] = response.status == 200
                checks['nosniff'] = headers.get('X-Content-Type-Options', '').lower() == 'nosniff'
                checks['frame_deny'] = headers.get('X-Frame-Options', '').upper() == 'DENY'
                checks['no_referrer'] = headers.get('Referrer-Policy', '').lower() == 'no-referrer'
                checks['hsts'] = headers.get('Strict-Transport-Security') == 'max-age=31536000'
                expected = browser_policy(admin) + "; frame-ancestors 'none'; upgrade-insecure-requests"
                checks['single_expected_csp'] = headers.get_all('Content-Security-Policy', []) == [expected]
                checks['permissions'] = headers.get('Permissions-Policy') == 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.stripe.com")'
                if private:
                    checks['no_store'] = headers.get('Cache-Control', '').lower() == 'no-store'
        except Exception as error:
            results.append({'path': path, 'ok': False, 'error': str(error)})
            continue
        results.append({'path': path, 'ok': all(checks.values()), 'checks': checks})
    return {'base_url': base_url, 'ok': all(item['ok'] for item in results), 'routes': results}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='https://love-essences.pt')
    args = parser.parse_args()
    report = verify(args.base_url)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['ok'] else 1)
