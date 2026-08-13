#!/usr/bin/env python3
"""Static validation for the generated Love Essences site."""

from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from build_site import (
    DOMAIN,
    OCCASION_TAGS,
    PRODUCT_TYPE_FILTERS,
    ROOT,
    get_routes,
    load_commercial_content,
    route_output_path,
)


def one(pattern: str, source: str, label: str, flags: int = 0) -> str:
    matches = re.findall(pattern, source, flags)
    if len(matches) != 1:
        raise AssertionError(f"{label}: esperado 1, encontrado {len(matches)}")
    return matches[0]


def validate(output: Path) -> None:
    source = (ROOT / "index.html").read_text(encoding="utf-8")
    products, routes = get_routes(source)
    commercial_content = load_commercial_content()
    errors: list[str] = []
    titles: dict[str, str] = {}
    descriptions: dict[str, str] = {}

    for route in routes:
        path = route_output_path(output, route)
        try:
            page = path.read_text(encoding="utf-8")
            title = one(r"<title>(.*?)</title>", page, "title", re.S)
            description = one(r'<meta name="description" content="([^"]+)"', page, "description")
            robots = one(r'<meta name="robots" content="([^"]+)"', page, "robots")
            canonical = one(r'<link rel="canonical" href="([^"]+)"', page, "canonical")
            schema_text = one(r'<script id="seo-structured-data" type="application/ld\+json">(.*?)</script>', page, "structured data", re.S)
            schema = json.loads(schema_text)

            assert '<html lang="pt-PT">' in page, "lang pt-PT ausente"
            assert f'<div class="page active" id="page-{route.page}">' in page, "rota não pré-renderizada"
            assert len(re.findall(r"<h1\b", page)) == 1, "a página deve ter exatamente um H1"
            assert re.search(
                rf'<div class="page active" id="page-{re.escape(route.page)}">.*?<h1[^>]*\bdata-page-heading\b',
                page,
                re.S,
            ), "H1 principal não pertence à página ativa"
            assert canonical == DOMAIN + route.path, f"canonical incorreta: {canonical}"
            assert ("noindex" not in robots) == route.index, f"robots incorreto: {robots}"
            assert schema.get("@context") == "https://schema.org", "@context inválido"
            assert len(schema.get("@graph", [])) >= 1, "@graph vazio"
            assert page.count('property="og:site_name"') == 1, "og:site_name ausente/duplicado"
            assert page.count('name="twitter:card"') == 1, "twitter card ausente/duplicado"
            assert page.count('src="./assets/js/analytics-config.js"') == 1, "config analytics ausente/duplicada"
            assert page.count('src="./assets/js/analytics.js"') == 1, "analytics ausente/duplicada"
            assert page.count('src="./assets/js/commercial-content.js"') == 1, "conteúdo comercial ausente/duplicado"
            assert page.count('href="/assets/css/site.css"') == 1, "CSS partilhado ausente/duplicado"
            assert page.count('src="/assets/js/site.js"') == 1, "JavaScript partilhado ausente/duplicado"

            content_key = f"category:{route.category}" if route.category else f"occasion:{route.occasion}" if route.occasion else ""
            route_content = commercial_content.get(content_key) if content_key else None
            if route_content:
                assert 'id="commercial-seo-content" hidden' not in page, "conteúdo comercial oculto"
                commercial_match = re.search(
                    r'<section class="commercial-seo-content" id="commercial-seo-content"[^>]*>(.*?)</section>',
                    page,
                    re.S,
                )
                assert commercial_match is not None, "secção comercial ausente"
                assert commercial_match.group(1).count('<article class="commercial-seo-card">') == 3, "estrutura H2 comercial incompleta"
                assert commercial_match.group(1).count("<details><summary>") == 3, "FAQ comercial incompleta"
                assert route_content["resultsHeading"] in page, "título da seleção de produtos incorreto"

            if route.product:
                graph_types = {item.get("@type") for item in schema["@graph"]}
                assert "Product" in graph_types, "Product schema ausente"
                assert "BreadcrumbList" in graph_types, "BreadcrumbList ausente"
                assert "aggregateRating" not in schema_text and '"review"' not in schema_text, "avaliação inventada"
                assert f'>{route.product.name}</h1>' in page, "H1 de produto incorreto"
                assert f'alt="{route.product.name}, Love Essences"' in page, "imagem principal/alt ausente"
                expected_related = sum(
                    route.product.product_id in product_ids
                    for product_ids in PRODUCT_TYPE_FILTERS.values()
                ) + sum(
                    any(tag in product_tag for product_tag in route.product.tags)
                    for tag in OCCASION_TAGS.values()
                )
                expected_related = min(expected_related, 5)
                related_match = re.search(r'id="pd-related-links"[^>]*>(.*?)</div>', page, re.S)
                assert related_match is not None, "links relacionados de produto ausentes"
                assert related_match.group(1).count("<a ") == expected_related, "links relacionados de produto incorretos"

            if route.index:
                if title in titles:
                    raise AssertionError(f"title duplicado com {titles[title]}")
                if description in descriptions:
                    raise AssertionError(f"description duplicada com {descriptions[description]}")
                titles[title] = route.path
                descriptions[description] = route.path
        except Exception as exc:
            errors.append(f"{route.path}: {exc}")

    try:
        sitemap_root = ET.parse(output / "sitemap.xml").getroot()
        namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
        sitemap_urls = [node.text for node in sitemap_root.findall("sm:url/sm:loc", namespace)]
        expected_urls = [DOMAIN + route.path for route in routes if route.index]
        assert sitemap_urls == expected_urls, "URLs do sitemap não correspondem às rotas indexáveis"
        assert len(sitemap_urls) == len(set(sitemap_urls)), "URLs duplicados no sitemap"
        assert f"{DOMAIN}/ocasioes/casamentos-e-batizados/" not in sitemap_urls, "rota antiga incluída no sitemap"
        for required_path in (
            "/ocasioes/casamento/",
            "/ocasioes/batizado/",
            "/ocasioes/comunhao/",
            "/categorias/difusores-personalizados/",
            "/categorias/sabonetes-artesanais/",
            "/categorias/velas-personalizadas/",
        ):
            assert DOMAIN + required_path in sitemap_urls, f"rota comercial ausente: {required_path}"
    except Exception as exc:
        errors.append(f"sitemap.xml: {exc}")

    try:
        robots = (output / "robots.txt").read_text(encoding="utf-8")
        assert "Disallow: /assets" not in robots, "assets bloqueados"
        assert f"Sitemap: {DOMAIN}/sitemap.xml" in robots, "referência ao sitemap ausente"
        assert "Disallow: /faturacao.html" in robots, "faturação não bloqueada"
    except Exception as exc:
        errors.append(f"robots.txt: {exc}")

    for forbidden in ("faturacao.html", "love-essences-v14.html", "love-essences-mobile-menu-premium-v3.html"):
        if (output / forbidden).exists():
            errors.append(f"ficheiro técnico publicado: {forbidden}")

    if not (output / "404.html").exists():
        errors.append("404.html ausente")
    elif 'name="robots" content="noindex, follow"' not in (output / "404.html").read_text(encoding="utf-8"):
        errors.append("404.html sem noindex")

    try:
        occasions_page = (output / "ocasioes" / "index.html").read_text(encoding="utf-8")
        for required_path in (
            "/ocasioes/casamento/",
            "/ocasioes/batizado/",
            "/ocasioes/comunhao/",
            "/categorias/difusores-personalizados/",
            "/categorias/sabonetes-artesanais/",
            "/categorias/velas-personalizadas/",
        ):
            assert required_path in occasions_page, f"link interno ausente: {required_path}"
    except Exception as exc:
        errors.append(f"arquitetura comercial: {exc}")

    if errors:
        print("Validação falhou:")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)

    print(f"Validação concluída: {len(routes)} rotas, {len(titles)} indexáveis, {len(products)} produtos.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="_site")
    args = parser.parse_args()
    validate((ROOT / args.output).resolve())


if __name__ == "__main__":
    main()
