#!/usr/bin/env python3
"""Build the public Love Essences site with prerendered SEO routes."""

from __future__ import annotations

import argparse
import base64
import html as html_lib
import json
import re
import shutil
import struct
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DOMAIN = "https://love-essences.pt"
SEO_START = "<!-- SEO:START -->"
SEO_END = "<!-- SEO:END -->"
SOCIAL_IMAGE = f"{DOMAIN}/assets/love-essences-social-preview.jpg?v=20260811"
ORGANIZATION_ID = f"{DOMAIN}/#organization"
RETURN_POLICY_URL = f"{DOMAIN}/devolucoes-e-reembolsos/"
RETURN_POLICY_ID = f"{RETURN_POLICY_URL}#policy"
SHIPPING_POLICY_URL = f"{DOMAIN}/politica-de-envio/"
SHIPPING_SERVICE_ID = f"{SHIPPING_POLICY_URL}#mainland-standard"
BUSINESS_DAYS = [
    "https://schema.org/Monday",
    "https://schema.org/Tuesday",
    "https://schema.org/Wednesday",
    "https://schema.org/Thursday",
    "https://schema.org/Friday",
]


@dataclass(frozen=True)
class Product:
    product_id: str
    name: str
    category: str
    image: str
    story: str
    details: str
    tags: tuple[str, ...]
    price: Optional[float]

    @property
    def slug(self) -> str:
        return slugify(self.name)

    @property
    def path(self) -> str:
        return f"/produtos/{self.slug}/"


@dataclass(frozen=True)
class Route:
    path: str
    page: str
    title: str
    description: str
    heading: str = ""
    label: str = ""
    image: str = SOCIAL_IMAGE
    og_type: str = "website"
    index: bool = True
    category: str = ""
    occasion: str = ""
    product: Optional[Product] = None


STATIC_ROUTES = [
    Route("/", "home", "Love Essences | Lembranças Personalizadas e Presentes Artesanais", "Descobre presentes artesanais e personalizados, sabonetes, velas, difusores e lembranças para momentos especiais, feitos à mão em Portugal.", label="Início"),
    Route("/loja/", "shop", "Loja de Presentes Artesanais e Personalizados | Love Essences", "Explora presentes artesanais, boxes, difusores, sabonetes, velas e lembranças personalizadas, criados à mão em Portugal.", heading="Cada peça é única.<br/><em>Como quem a vai receber.</em>", label="Loja"),
    Route("/ocasioes/", "occasions", "Lembranças Personalizadas em Portugal | Love Essences", "Descobre lembranças personalizadas e artesanais para convidados, casamentos, batizados, comunhões e eventos, feitas à mão em Portugal.", label="Lembranças Personalizadas"),
    Route("/sobre-nos/", "about", "Sobre Nós | Love Essences", "Conhece a Love Essences, uma marca portuguesa de presentes artesanais feitos à mão com cuidado, intenção e personalização.", label="Sobre Nós"),
    Route("/contactos/", "contact", "Projetos Totalmente Personalizados | Love Essences", "Conta-nos a tua ideia para criarmos lembranças e presentes totalmente personalizados, com proposta e orçamento à tua medida.", label="Personalizados"),
    Route("/checkout/", "checkout", "Checkout Seguro | Love Essences", "Conclui a tua encomenda Love Essences através do checkout seguro.", label="Checkout", index=False),
    Route("/projeto/orcamento/", "quote", "Proposta Personalizada | Love Essences", "Consulta e aprova a tua proposta personalizada Love Essences.", label="Proposta", index=False),
    Route("/encomenda/confirmacao/", "confirmation", "Confirmação da Encomenda | Love Essences", "Consulta a confirmação da tua encomenda Love Essences.", label="Confirmação", index=False),
    Route("/acompanhar-encomenda/", "tracking", "Acompanhar Encomenda | Love Essences", "Consulta como acompanhar a tua encomenda Love Essences através do serviço oficial dos CTT.", label="Acompanhar Encomenda", index=False),
    Route("/politica-de-privacidade/", "privacy", "Política de Privacidade | Love Essences", "Consulta como a Love Essences recolhe, utiliza e protege dados pessoais e gere cookies no website.", label="Política de Privacidade"),
    Route("/termos-de-servico/", "terms", "Termos de Serviço | Love Essences", "Consulta os termos aplicáveis a produtos, personalizações, encomendas, pagamentos e utilização do website Love Essences.", label="Termos de Serviço"),
    Route("/devolucoes-e-reembolsos/", "returns", "Devoluções e Reembolsos | Love Essences", "Consulta as condições de devolução, troca e reembolso para produtos artesanais e personalizados Love Essences.", label="Devoluções e Reembolsos"),
    Route("/politica-de-envio/", "shipping", "Política de Envio | Love Essences", "Consulta os métodos, custos, destinos e prazos de preparação e envio das encomendas Love Essences.", label="Política de Envio"),
]

CATEGORY_ROUTES = {
    "pecas": Route("/categorias/colecao-assinatura/", "shop", "Coleção Assinatura | Love Essences", "Descobre a Coleção Assinatura Love Essences: peças artesanais feitas à mão para oferecer e guardar momentos especiais.", heading="Coleção <em>Assinatura</em>", label="Coleção Assinatura", category="pecas"),
    "memorias": Route("/categorias/colecao-memorias/", "shop", "Boxes e Presentes da Coleção Memórias | Love Essences", "Descobre boxes e presentes artesanais da Coleção Memórias, preparados para oferecer a alguém especial.", heading="Coleção <em>Memórias</em>", label="Coleção Memórias", category="memorias"),
    "eventos": Route("/categorias/lembrancas-para-eventos/", "shop", "Lembranças Personalizadas para Eventos | Love Essences", "Descobre difusores, sabonetes, velas e outras lembranças personalizadas para casamentos, batizados, comunhões e eventos.", heading="Lembranças personalizadas<br/><em>para eventos</em>", label="Lembranças para Eventos", category="eventos"),
    "difusores": Route("/categorias/difusores-personalizados/", "shop", "Difusores Personalizados para Eventos | Love Essences", "Descobre mini difusores personalizados para casamento, batizado, comunhão e eventos, com fragrância e detalhes adaptados à celebração.", heading="Difusores<br/><em>personalizados</em>", label="Difusores Personalizados", category="difusores"),
    "sabonetes": Route("/categorias/sabonetes-artesanais/", "shop", "Sabonetes Artesanais para Lembranças | Love Essences", "Descobre sabonetes artesanais e lembranças personalizadas com sabonete para casamentos, batizados, comunhões e eventos.", heading="Sabonetes artesanais<br/><em>e personalizados</em>", label="Sabonetes Artesanais", category="sabonetes"),
    "velas": Route("/categorias/velas-personalizadas/", "shop", "Velas Personalizadas para Eventos | Love Essences", "Encontra velas personalizadas para casamento, batizado, comunhão e eventos, com fragrâncias e acabamentos do catálogo Love Essences.", heading="Velas<br/><em>personalizadas</em>", label="Velas Personalizadas", category="velas"),
}

OCCASION_ROUTES = {
    "aniversarios": Route("/ocasioes/aniversarios/", "shop", "Presentes de Aniversário Personalizados | Love Essences", "Encontra presentes artesanais e personalizados para celebrar aniversários com um gesto único e feito à mão.", heading="Presentes personalizados<br/><em>para aniversários</em>", label="Aniversários", occasion="aniversarios"),
    "presente-romantico": Route("/ocasioes/presente-romantico/", "shop", "Presentes Românticos Personalizados | Love Essences", "Descobre presentes românticos artesanais e personalizados, criados para celebrar histórias, pessoas e momentos especiais.", heading="Presentes românticos<br/><em>personalizados</em>", label="Presente Romântico", occasion="presente-romantico"),
    "alguem-especial": Route("/ocasioes/alguem-especial/", "shop", "Presentes Personalizados para Alguém Especial | Love Essences", "Escolhe um presente artesanal e personalizado para surpreender alguém especial com intenção e cuidado.", heading="Presentes para<br/><em>alguém especial</em>", label="Para Alguém Especial", occasion="alguem-especial"),
    "casamentos-batizados": Route("/ocasioes/casamentos-e-batizados/", "shop", "Lembranças para Casamento, Batizado e Comunhão | Love Essences", "Escolhe a celebração para encontrares lembranças personalizadas de casamento, batizado ou comunhão.", heading="Escolhe a tua<br/><em>celebração</em>", label="Casamento, Batizado e Comunhão", index=False, occasion="casamentos-batizados"),
    "casamento": Route("/ocasioes/casamento/", "shop", "Lembranças de Casamento Personalizadas | Love Essences", "Descobre lembranças de casamento personalizadas para convidados, incluindo difusores, sabonetes, velas e detalhes artesanais.", heading="Lembranças de casamento<br/><em>personalizadas</em>", label="Casamento", occasion="casamento"),
    "batizado": Route("/ocasioes/batizado/", "shop", "Lembranças de Batizado Personalizadas | Love Essences", "Encontra lembranças de batizado ou batismo personalizadas para convidados e crianças, feitas artesanalmente em Portugal.", heading="Lembranças de batizado<br/><em>personalizadas</em>", label="Batizado", occasion="batizado"),
    "comunhao": Route("/ocasioes/comunhao/", "shop", "Lembranças de Comunhão Personalizadas | Love Essences", "Descobre lembranças de primeira comunhão personalizadas para convidados, com opções artesanais para adultos e crianças.", heading="Lembranças de comunhão<br/><em>personalizadas</em>", label="Comunhão", occasion="comunhao"),
    "empresas": Route("/ocasioes/eventos-e-empresas/", "shop", "Lembranças para Eventos e Empresas | Love Essences", "Encontra lembranças e brindes personalizados para eventos e empresas, adaptados ao tema e à identidade de cada ocasião.", heading="Lembranças para eventos<br/><em>e empresas</em>", label="Eventos e Empresas", occasion="empresas"),
    "pequeninos": Route("/ocasioes/mais-pequeninos/", "shop", "Lembranças Personalizadas para Crianças | Love Essences", "Descobre kits criativos, doces e lembranças personalizadas pensadas para festas, batizados e pequenos convidados.", heading="Lembranças para<br/><em>os mais pequeninos</em>", label="Para os Mais Pequeninos", occasion="pequeninos"),
}

CATEGORY_BY_NAME = {
    "Coleção Assinatura": "pecas",
    "Coleção Memórias": "memorias",
    "Lembranças para Eventos": "eventos",
}

PRODUCT_TYPE_FILTERS = {
    "difusores": {"mini_difusor", "aroma_em_viagem", "mini_difusor_sabonete"},
    "sabonetes": {"trouxinha_aromatica", "bem_querer", "mini_difusor_sabonete", "bilhete_perfumado"},
    "velas": {"luz_serena", "doce_luz", "memoria_perfumada"},
}

OCCASION_TAGS = {
    "casamento": "Casamentos",
    "batizado": "Batizados",
    "comunhao": "Comunhões",
}


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value)
    ascii_value = "".join(char for char in normalized if unicodedata.category(char) != "Mn")
    ascii_value = ascii_value.lower().replace("&", " e ")
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", ascii_value))


def js_string(block: str, field: str) -> str:
    match = re.search(rf"(?m)^    {re.escape(field)}: '((?:\\.|[^'])*)'", block)
    if not match:
        return ""
    return match.group(1).replace("\\'", "'").replace("\\n", " ")


def parse_products(source: str) -> list[Product]:
    start = source.index("var PRODUCT_CATALOG = {")
    end = source.index("\n};\n\nvar currentProduct", start)
    catalog = source[start:end]
    matches = list(re.finditer(r"(?m)^  ([a-z][a-z0-9_]+): \{", catalog))
    products: list[Product] = []
    for index, match in enumerate(matches):
        block_end = matches[index + 1].start() if index + 1 < len(matches) else len(catalog)
        block = catalog[match.start():block_end]
        price_values = [float(value) for value in re.findall(r"\bprice:\s*([0-9]+(?:\.[0-9]+)?)", block)]
        base_price = re.search(r"(?m)^    basePrice:\s*([0-9]+(?:\.[0-9]+)?)", block)
        tags_match = re.search(r"(?m)^    tags:\s*\[(.*?)\]", block)
        tags = tuple(re.findall(r"'((?:\\.|[^'])*)'", tags_match.group(1))) if tags_match else ()
        if base_price:
            price_values.append(float(base_price.group(1)))
        product = Product(
            product_id=match.group(1),
            name=js_string(block, "name"),
            category=js_string(block, "category"),
            image=js_string(block, "image"),
            story=js_string(block, "story"),
            details=js_string(block, "details"),
            tags=tags,
            price=min(price_values) if price_values else None,
        )
        if not all((product.name, product.category, product.image, product.story)):
            raise ValueError(f"Produto incompleto no catálogo: {product.product_id}")
        products.append(product)
    slugs = [product.slug for product in products]
    if len(slugs) != len(set(slugs)):
        raise ValueError("Existem slugs de produto duplicados")
    return products


def load_commercial_content() -> dict[str, dict]:
    source = (ROOT / "assets" / "js" / "commercial-content.js").read_text(encoding="utf-8")
    match = re.search(r"window\.LOVE_COMMERCIAL_CONTENT\s*=\s*(\{.*\})\s*;\s*$", source, re.S)
    if not match:
        raise ValueError("Conteúdo comercial não encontrado")
    content = json.loads(match.group(1))
    if not isinstance(content, dict):
        raise ValueError("Conteúdo comercial inválido")
    return content


def commercial_content_for(route: Route, content: dict[str, dict]) -> Optional[dict]:
    key = f"category:{route.category}" if route.category else f"occasion:{route.occasion}" if route.occasion else ""
    return content.get(key) if key else None


def render_commercial_content(content: dict) -> str:
    cards = "".join(
        '<article class="commercial-seo-card"><h2>'
        + html_lib.escape(item["title"])
        + "</h2><p>"
        + html_lib.escape(item["body"])
        + "</p></article>"
        for item in content.get("sections", [])
    )
    related = "".join(
        '<a href="' + html_lib.escape(item["url"], quote=True) + '">' + html_lib.escape(item["label"]) + "</a>"
        for item in content.get("related", [])
    )
    faq = "".join(
        "<details><summary>"
        + html_lib.escape(item["question"])
        + "</summary><p>"
        + html_lib.escape(item["answer"])
        + "</p></details>"
        for item in content.get("faq", [])
    )
    return (
        '<section class="commercial-seo-content" id="commercial-seo-content" aria-label="Informação para escolher e encomendar">'
        '<div class="commercial-seo-inner" id="commercial-seo-inner">'
        '<div class="commercial-seo-grid">'
        + cards
        + '</div><nav class="commercial-related" aria-label="Explorar páginas relacionadas">'
        + related
        + '</nav><div class="commercial-faq"><h2>Perguntas frequentes</h2><div class="commercial-faq-list">'
        + faq
        + "</div></div></div></section>"
    )


def product_related_links(product: Product) -> str:
    links: list[tuple[str, str]] = []
    for category, product_ids in PRODUCT_TYPE_FILTERS.items():
        if product.product_id in product_ids:
            route = CATEGORY_ROUTES[category]
            links.append((route.label, route.path))
    for occasion, tag in OCCASION_TAGS.items():
        if any(tag in product_tag for product_tag in product.tags):
            route = OCCASION_ROUTES[occasion]
            links.append((route.label, route.path))
    return "".join(
        '<a href="' + html_lib.escape(url, quote=True) + '">' + html_lib.escape(label) + "</a>"
        for label, url in links[:5]
    )


def clean_description(value: str, limit: int = 160) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= limit:
        return value
    shortened = value[: limit - 1].rsplit(" ", 1)[0]
    return shortened + "…"


def absolute_asset(path: str) -> str:
    if path.startswith(("http://", "https://")):
        return path
    return f"{DOMAIN}/{path.lstrip('./')}"


def breadcrumb(items: list[tuple[str, str]]) -> dict:
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": index + 1, "name": name, "item": url}
            for index, (name, url) in enumerate(items)
        ],
    }


def merchant_return_policy() -> dict:
    """Standard policy for personalised and made-to-order products."""
    return {
        "@type": "MerchantReturnPolicy",
        "@id": RETURN_POLICY_ID,
        "merchantReturnLink": RETURN_POLICY_URL,
        "applicableCountry": "PT",
        "returnPolicyCountry": "PT",
        "returnPolicyCategory": "https://schema.org/MerchantReturnNotPermitted",
    }


def mainland_shipping_service() -> dict:
    """Shipping terms shown on the site for mainland Portugal."""
    destination = {
        "@type": "DefinedRegion",
        "name": "Portugal Continental",
        "addressCountry": "PT",
    }
    transit_time = {
        "@type": "ServicePeriod",
        "duration": {
            "@type": "QuantitativeValue",
            "minValue": 2,
            "maxValue": 2,
            "unitCode": "DAY",
        },
        "businessDays": BUSINESS_DAYS,
    }
    return {
        "@type": "ShippingService",
        "@id": SHIPPING_SERVICE_ID,
        "name": "Envio Expresso — Portugal Continental",
        "description": "Portes de 5,90 € abaixo de 60 € e gratuitos a partir de 60 €; produção habitual de 3 a 5 dias úteis e entrega em 2 dias úteis após expedição.",
        "fulfillmentType": "https://schema.org/FulfillmentTypeDelivery",
        "handlingTime": {
            "@type": "ServicePeriod",
            "duration": {
                "@type": "QuantitativeValue",
                "minValue": 3,
                "maxValue": 5,
                "unitCode": "DAY",
            },
            "businessDays": BUSINESS_DAYS,
        },
        "shippingConditions": [
            {
                "@type": "ShippingConditions",
                "shippingDestination": destination,
                "orderValue": {
                    "@type": "MonetaryAmount",
                    "minValue": 0,
                    "maxValue": 59.99,
                    "currency": "EUR",
                },
                "shippingRate": {
                    "@type": "MonetaryAmount",
                    "value": 5.90,
                    "currency": "EUR",
                },
                "transitTime": transit_time,
            },
            {
                "@type": "ShippingConditions",
                "shippingDestination": destination,
                "orderValue": {
                    "@type": "MonetaryAmount",
                    "minValue": 60,
                    "currency": "EUR",
                },
                "shippingRate": {
                    "@type": "MonetaryAmount",
                    "value": 0,
                    "currency": "EUR",
                },
                "transitTime": transit_time,
            },
        ],
    }


def schema_for(route: Route) -> dict:
    canonical = DOMAIN + route.path
    graph: list[dict] = []
    if route.page == "home":
        graph.extend([
            {
                "@type": "OnlineStore",
                "@id": ORGANIZATION_ID,
                "name": "Love Essences",
                "url": f"{DOMAIN}/",
                "logo": f"{DOMAIN}/assets/love-essences-social-logo.png",
                "description": route.description,
                "email": "love-essences@outlook.com",
                "address": {"@type": "PostalAddress", "addressCountry": "PT"},
                "sameAs": ["https://www.instagram.com/lovessences.art"],
                "hasMerchantReturnPolicy": {"@id": RETURN_POLICY_ID},
                "hasShippingService": {"@id": SHIPPING_SERVICE_ID},
            },
            {
                "@type": "WebSite",
                "@id": f"{DOMAIN}/#website",
                "url": f"{DOMAIN}/",
                "name": "Love Essences",
                "inLanguage": "pt-PT",
                "publisher": {"@id": ORGANIZATION_ID},
            },
        ])
    elif route.product:
        product = route.product
        product_schema = {
            "@type": "Product",
            "@id": canonical + "#product",
            "name": product.name,
            "image": [absolute_asset(product.image)],
            "description": product.story,
            "brand": {"@type": "Brand", "name": "Love Essences"},
            "sku": product.product_id,
            "url": canonical,
        }
        if product.price is not None:
            product_schema["offers"] = {
                "@type": "Offer",
                "url": canonical,
                "price": f"{product.price:.2f}",
                "priceCurrency": "EUR",
                "availability": "https://schema.org/InStock",
                "itemCondition": "https://schema.org/NewCondition",
                "seller": {"@id": ORGANIZATION_ID},
                "hasMerchantReturnPolicy": {"@id": RETURN_POLICY_ID},
                "shippingDetails": {
                    "@type": "OfferShippingDetails",
                    "hasShippingService": {"@id": SHIPPING_SERVICE_ID},
                },
            }
        category_key = CATEGORY_BY_NAME[product.category]
        category_route = CATEGORY_ROUTES[category_key]
        graph.extend([
            product_schema,
            breadcrumb([
                ("Início", f"{DOMAIN}/"),
                ("Loja", f"{DOMAIN}/loja/"),
                (product.category, DOMAIN + category_route.path),
                (product.name, canonical),
            ]),
        ])
    else:
        if route.page == "about":
            page_type = "AboutPage"
        elif route.page == "contact":
            page_type = "ContactPage"
        elif route.page in {"shop", "occasions"} or route.category or route.occasion:
            page_type = "CollectionPage"
        else:
            page_type = "WebPage"
        graph.append({
            "@type": page_type,
            "@id": canonical + "#webpage",
            "url": canonical,
            "name": route.title,
            "description": route.description,
            "inLanguage": "pt-PT",
            "isPartOf": {"@id": f"{DOMAIN}/#website"},
        })
        crumb_items = [("Início", f"{DOMAIN}/")]
        if route.category or route.occasion:
            crumb_items.append(("Loja", f"{DOMAIN}/loja/"))
        crumb_items.append((route.label, canonical))
        graph.append(breadcrumb(crumb_items))
        if route.page == "returns":
            graph.append({
                "@type": "OnlineStore",
                "@id": ORGANIZATION_ID,
                "name": "Love Essences",
                "url": f"{DOMAIN}/",
                "hasMerchantReturnPolicy": merchant_return_policy(),
            })
        elif route.page == "shipping":
            graph.append({
                "@type": "OnlineStore",
                "@id": ORGANIZATION_ID,
                "name": "Love Essences",
                "url": f"{DOMAIN}/",
                "hasShippingService": mainland_shipping_service(),
            })
    return {"@context": "https://schema.org", "@graph": graph}


def image_dimensions(path: Path) -> Optional[tuple[int, int]]:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 9 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            offset += 2
            if marker in {0xD8, 0xD9}:
                continue
            if offset + 2 > len(data):
                break
            length = struct.unpack(">H", data[offset:offset + 2])[0]
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
                return width, height
            offset += length
    return None


def seo_block(route: Route) -> str:
    title = html_lib.escape(route.title, quote=True)
    description = html_lib.escape(clean_description(route.description), quote=True)
    canonical = DOMAIN + route.path
    image = route.image
    image_file = ROOT / image.replace(DOMAIN + "/", "").split("?", 1)[0]
    dimensions = image_dimensions(image_file)
    image_width, image_height = dimensions or (792, 923)
    image_alt = f"{route.product.name}, produto Love Essences" if route.product else "Arranjo floral artesanal Love Essences em tons de rosa, coral e amarelo"
    robots = "index, follow, max-image-preview:large" if route.index else "noindex, follow"
    structured = json.dumps(schema_for(route), ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return f'''{SEO_START}
<title>{title}</title>
<meta name="description" content="{description}"/>
<meta name="robots" content="{robots}"/>
<link rel="canonical" href="{canonical}"/>
<meta property="og:title" content="{title}"/>
<meta property="og:description" content="{description}"/>
<meta property="og:image" content="{image}"/>
<meta property="og:image:secure_url" content="{image}"/>
<meta property="og:image:type" content="image/{'png' if image.lower().split('?', 1)[0].endswith('.png') else 'jpeg'}"/>
<meta property="og:image:width" content="{image_width}"/>
<meta property="og:image:height" content="{image_height}"/>
<meta property="og:image:alt" content="{html_lib.escape(image_alt, quote=True)}"/>
<meta property="og:url" content="{canonical}"/>
<meta property="og:type" content="{route.og_type}"/>
<meta property="og:site_name" content="Love Essences"/>
<meta property="og:locale" content="pt_PT"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="{title}"/>
<meta name="twitter:description" content="{description}"/>
<meta name="twitter:image" content="{image}"/>
<meta name="twitter:image:alt" content="{html_lib.escape(image_alt, quote=True)}"/>
<script id="seo-structured-data" type="application/ld+json">{structured}</script>
{SEO_END}'''


def replace_seo(source: str, route: Route) -> str:
    start = source.index(SEO_START)
    end = source.index(SEO_END, start) + len(SEO_END)
    return source[:start] + seo_block(route) + source[end:]


def activate_page(source: str, page: str) -> str:
    source = source.replace('<div class="page active" id="page-home">', '<div class="page" id="page-home">', 1)
    target = f'<div class="page" id="page-{page}">'
    if target not in source:
        raise ValueError(f"Página interna não encontrada: {page}")
    return source.replace(target, f'<div class="page active" id="page-{page}">', 1)


def prerender_route(source: str, route: Route, commercial_content: dict[str, dict]) -> str:
    source = activate_page(source, route.page)
    if route.page == "shop" and route.heading:
        source = re.sub(
            r'<h[12] class="section-title" id="shop-page-title" data-page-heading>.*?</h[12]>',
            f'<h2 class="section-title" id="shop-page-title" data-page-heading>{route.heading}</h2>',
            source,
            count=1,
            flags=re.S,
        )
        route_content = commercial_content_for(route, commercial_content)
        if route_content:
            source = re.sub(
                r'(<p id="shop-page-intro">).*?(</p>)',
                lambda match: match.group(1) + html_lib.escape(route_content["intro"]) + match.group(2),
                source,
                count=1,
                flags=re.S,
            )
            source = re.sub(
                r'(<h2 class="shop-results-label" id="shop-results-label">).*?(</h2>)',
                lambda match: match.group(1) + html_lib.escape(route_content["resultsHeading"]) + match.group(2),
                source,
                count=1,
                flags=re.S,
            )
            source = re.sub(
                r'<section class="commercial-seo-content" id="commercial-seo-content" hidden[^>]*>.*?</section>',
                render_commercial_content(route_content),
                source,
                count=1,
                flags=re.S,
            )
    if route.product:
        product = route.product
        category_key = CATEGORY_BY_NAME[product.category]
        price_text = f"{product.price:.2f}€".replace(".", ",") if product.price is not None else "Sob consulta"
        source = re.sub(r'<div class="pd-visual" id="pd-visual">.*?</div>', f'<div class="pd-visual" id="pd-visual"><img src="/{product.image}" alt="{html_lib.escape(product.name, quote=True)}, Love Essences" loading="eager" fetchpriority="high"/></div>', source, count=1, flags=re.S)
        source = re.sub(r'(<p class="pd-category" id="pd-category">).*?(</p>)', lambda match: match.group(1) + '✦ ' + html_lib.escape(product.category) + match.group(2), source, count=1, flags=re.S)
        source = re.sub(r'(<h[12] class="pd-name" id="pd-name" data-page-heading>).*?(</h[12]>)', lambda match: match.group(1) + html_lib.escape(product.name) + match.group(2), source, count=1, flags=re.S)
        source = re.sub(r'(<p class="pd-price" id="pd-price">).*?(</p>)', lambda match: match.group(1) + price_text + match.group(2), source, count=1, flags=re.S)
        source = source.replace('<p id="pd-story"></p>', f'<p id="pd-story">{html_lib.escape(product.story)}</p>', 1)
        source = source.replace('<p id="pd-details"></p>', f'<p id="pd-details">{html_lib.escape(product.details)}</p>', 1)
        source = re.sub(r'(<li id="product-breadcrumb-category">).*?(</li>)', lambda match: match.group(1) + f'<a href="{CATEGORY_ROUTES[category_key].path}">{html_lib.escape(product.category)}</a>' + match.group(2), source, count=1, flags=re.S)
        source = re.sub(r'(<li id="product-breadcrumb-name" aria-current="page">).*?(</li>)', lambda match: match.group(1) + html_lib.escape(product.name) + match.group(2), source, count=1, flags=re.S)
        source = re.sub(
            r'(<div class="pd-related-links" id="pd-related-links"[^>]*>).*?(</div>)',
            lambda match: match.group(1) + product_related_links(product) + match.group(2),
            source,
            count=1,
            flags=re.S,
        )
    return source


def enforce_single_h1(source: str, page: str) -> str:
    heading_pattern = re.compile(r'<h[12]([^>]*\bdata-page-heading\b[^>]*)>(.*?)</h[12]>', re.S)
    source = heading_pattern.sub(lambda match: f'<h2{match.group(1)}>{match.group(2)}</h2>', source)
    active_pattern = re.compile(
        rf'(<div class="page active" id="page-{re.escape(page)}">.*?)'
        r'<h2([^>]*\bdata-page-heading\b[^>]*)>(.*?)</h2>',
        re.S,
    )
    source, replacements = active_pattern.subn(
        lambda match: f'{match.group(1)}<h1{match.group(2)}>{match.group(3)}</h1>',
        source,
        count=1,
    )
    if replacements != 1:
        raise ValueError(f"Título principal não encontrado na página: {page}")
    return source


def add_product_links(source: str, products: list[Product]) -> str:
    for product in products:
        escaped_name = html_lib.escape(product.name)
        old = f'<h3 class="product-name">{escaped_name}</h3>'
        new = f'<h3 class="product-name"><a href="{product.path}" onclick="openProduct(\'{product.product_id}\'); return false;">{escaped_name}</a></h3>'
        source = source.replace(old, new)
    return source


def extract_inline_logo(source: str, output: Path) -> str:
    pattern = re.compile(r'<img src="data:image/png;base64,([^"]+)" alt="Love Essences" />')
    match = pattern.search(source)
    if not match:
        return source
    logo_path = output / "assets" / "love-essences-logo.png"
    logo_path.parent.mkdir(parents=True, exist_ok=True)
    logo_path.write_bytes(base64.b64decode(match.group(1)))
    dimensions = image_dimensions(logo_path) or (1876, 162)
    replacement = f'<img src="/assets/love-essences-logo.png" alt="Love Essences" width="{dimensions[0]}" height="{dimensions[1]}" />'
    return source[:match.start()] + replacement + source[match.end():]


def extract_shared_assets(source: str, output: Path) -> str:
    styles = re.findall(r"<style>(.*?)</style>", source, flags=re.S)
    if not styles:
        raise ValueError("CSS inline principal não encontrado")
    css = "\n\n".join(styles)
    css = css.replace("url('assets/", "url('/assets/").replace('url("assets/', 'url("/assets/')
    css_path = output / "assets" / "css" / "site.css"
    css_path.parent.mkdir(parents=True, exist_ok=True)
    css_path.write_text(css.strip() + "\n", encoding="utf-8")
    source = re.sub(r"<style>.*?</style>", '<link rel="stylesheet" href="/assets/css/site.css"/>', source, count=1, flags=re.S)
    source = re.sub(r"<style>.*?</style>", "", source, flags=re.S)

    footer_end = source.index("</footer>") + len("</footer>")
    before_scripts, after_footer = source[:footer_end], source[footer_end:]
    scripts = re.findall(r"<script>(.*?)</script>", after_footer, flags=re.S)
    if not scripts:
        raise ValueError("JavaScript inline principal não encontrado")
    js_path = output / "assets" / "js" / "site.js"
    js_path.parent.mkdir(parents=True, exist_ok=True)
    js_path.write_text("\n;\n".join(scripts).strip() + "\n", encoding="utf-8")
    after_footer = re.sub(r"<script>.*?</script>", '<script src="/assets/js/site.js"></script>', after_footer, count=1, flags=re.S)
    after_footer = re.sub(r"<script>.*?</script>", "", after_footer, flags=re.S)
    return before_scripts + after_footer


def add_image_dimensions(source: str, output: Path) -> str:
    pattern = re.compile(r'<img\b[^>]*\bsrc="([^"]+)"[^>]*>')

    def replace(match: re.Match[str]) -> str:
        tag, src = match.group(0), match.group(1)
        if " width=" in tag or src.startswith(("data:", "http://", "https://")):
            return tag
        local = src.split("?", 1)[0].lstrip("./")
        dimensions = image_dimensions(output / local) or image_dimensions(ROOT / local)
        if not dimensions:
            return tag
        addition = f' width="{dimensions[0]}" height="{dimensions[1]}"'
        return tag[:-2] + addition + "/>" if tag.endswith("/>") else tag[:-1] + addition + ">"

    return pattern.sub(replace, source)


def route_output_path(output: Path, route: Route) -> Path:
    if route.path == "/":
        return output / "index.html"
    return output / route.path.strip("/") / "index.html"


def write_sitemap(output: Path, routes: list[Route]) -> str:
    today = datetime.now(ZoneInfo("Europe/Lisbon")).date().isoformat()
    urls = "\n".join(
        f"  <url>\n    <loc>{DOMAIN}{route.path}</loc>\n    <lastmod>{today}</lastmod>\n  </url>"
        for route in routes if route.index
    )
    sitemap = f'''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{urls}
</urlset>
'''
    (output / "sitemap.xml").write_text(sitemap, encoding="utf-8")
    return sitemap


def write_robots(output: Path) -> str:
    robots = f'''User-agent: *
Allow: /
Disallow: /faturacao.html
Disallow: /love-essences-v14.html
Disallow: /love-essences-mobile-menu-premium-v3.html

Sitemap: {DOMAIN}/sitemap.xml
'''
    (output / "robots.txt").write_text(robots, encoding="utf-8")
    return robots


def write_404(output: Path) -> None:
    page = f'''<!doctype html>
<html lang="pt-PT">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Página não encontrada | Love Essences</title>
  <meta name="description" content="A página que procuras não foi encontrada."/>
  <meta name="robots" content="noindex, follow"/>
  <link rel="icon" href="/assets/love-essences-social-logo.png"/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400&amp;family=Quicksand:wght@400;500;600&amp;display=swap" rel="stylesheet"/>
  <style>
    *{{box-sizing:border-box}}body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem;background:linear-gradient(145deg,#fff 0%,#f1e3ef 100%);color:#3f073a;font-family:Quicksand,sans-serif;text-align:center}}main{{max-width:680px;padding:clamp(2rem,6vw,4.5rem);background:rgba(255,255,255,.9);border:1px solid rgba(180,104,171,.18);border-radius:28px;box-shadow:0 24px 70px rgba(102,19,94,.12)}}.code{{color:#b468ab;font-size:.78rem;font-weight:600;letter-spacing:.2em;text-transform:uppercase}}h1{{margin:.7rem 0 1rem;font:400 clamp(2.5rem,8vw,5rem)/.95 'Cormorant Garamond',serif}}p{{color:#6b5269;line-height:1.8}}nav{{display:flex;flex-wrap:wrap;justify-content:center;gap:.8rem;margin-top:2rem}}a{{padding:.85rem 1.25rem;border-radius:999px;text-decoration:none;font-size:.8rem;font-weight:600}}a:first-child{{background:#66135e;color:#fff}}a:last-child{{border:1px solid #b468ab;color:#66135e}}
  </style>
</head>
<body><main><div class="code">Erro 404</div><h1>Esta página perdeu-se pelo caminho.</h1><p>O endereço pode ter mudado ou já não existir. Volta ao início ou continua a descobrir os presentes Love Essences.</p><nav><a href="/">Voltar ao início</a><a href="/loja/">Explorar a loja</a></nav></main></body>
</html>
'''
    (output / "404.html").write_text(page, encoding="utf-8")


def get_routes(source: str) -> tuple[list[Product], list[Route]]:
    products = parse_products(source)
    product_routes = [
        Route(
            product.path,
            "product",
            f"{product.name} | Love Essences",
            product.story,
            label=product.name,
            image=absolute_asset(product.image),
            og_type="product",
            product=product,
        )
        for product in products
    ]
    routes = STATIC_ROUTES + list(CATEGORY_ROUTES.values()) + list(OCCASION_ROUTES.values()) + product_routes
    return products, routes


def build(output: Path, sync_root_seo: bool) -> None:
    output = output.resolve()
    if output == ROOT or ROOT not in output.parents:
        raise ValueError("O diretório de build tem de estar dentro do projeto e não pode ser a raiz")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)

    for directory in ("assets", "dist", "admin"):
        shutil.copytree(ROOT / directory, output / directory)
    shutil.copy2(ROOT / ".nojekyll", output / ".nojekyll")
    for filename in ("_headers", "_redirects"):
        source_file = ROOT / filename
        if source_file.exists():
            shutil.copy2(source_file, output / filename)

    source = (ROOT / "index.html").read_text(encoding="utf-8")
    products, routes = get_routes(source)
    commercial_content = load_commercial_content()
    source = source.replace('<meta name="viewport" content="width=device-width, initial-scale=1.0"/>', '<meta name="viewport" content="width=device-width, initial-scale=1.0"/>\n<base href="/"/>', 1)
    source = extract_inline_logo(source, output)
    source = add_product_links(source, products)
    source = extract_shared_assets(source, output)

    for route in routes:
        rendered = replace_seo(source, route)
        rendered = prerender_route(rendered, route, commercial_content)
        rendered = enforce_single_h1(rendered, route.page)
        rendered = add_image_dimensions(rendered, output)
        destination = route_output_path(output, route)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(rendered, encoding="utf-8")

    sitemap = write_sitemap(output, routes)
    robots = write_robots(output)
    write_404(output)
    if sync_root_seo:
        (ROOT / "sitemap.xml").write_text(sitemap, encoding="utf-8")
        (ROOT / "robots.txt").write_text(robots, encoding="utf-8")

    print(f"Build concluído: {len(routes)} rotas ({sum(route.index for route in routes)} indexáveis), {len(products)} produtos.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="_site", help="Diretório de saída dentro do projeto")
    parser.add_argument("--sync-root-seo", action="store_true", help="Atualiza também robots.txt e sitemap.xml da raiz")
    args = parser.parse_args()
    build(ROOT / args.output, args.sync_root_seo)


if __name__ == "__main__":
    main()
