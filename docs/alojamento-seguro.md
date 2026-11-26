# Cabeçalhos HTTP — Love Essences

O build escreve `_site/_headers` a partir de `scripts/hosting_security.py`, que
também produz a CSP dos documentos HTML. O GitHub Pages atual ignora `_headers`:
publicar o ficheiro não ativa os cabeçalhos no domínio real.

## Alternativa: manter GitHub Pages com um proxy Cloudflare

Esta opção mantém o workflow e o alojamento atuais. Antes de alterar nameservers,
exportar a zona DNS completa na Amen e conferir todos os registos na Cloudflare,
incluindo email e DNSSEC. Usar o plano gratuito apenas se a conta confirmar que
inclui as regras necessárias. Configurar TLS Full (strict), manter as proteções
de scripts/HTML existentes e aplicar regras de resposta com operação **Set**.

O comando seguinte gera as quatro regras, por ordem: público, CSP do admin,
cache das rotas sensíveis e revalidação dos assets. Conferir e preservar regras
já existentes na zona; não substituir um ruleset inteiro sem o ler primeiro.

```sh
python3 scripts/hosting_security.py
```

Conferir o certificado e o funcionamento antes de ativar HSTS. Não usar TLS
Flexible. Não ativar otimizações que reescrevam JavaScript sem testar novamente
a CSP. Confirmar o comportamento da cache na borda separadamente: alterar o
cabeçalho de resposta Cache-Control não altera a decisão de cache da Cloudflare.
Só depois de verificar a zona e o plano, mudar os nameservers na Amen e repetir
o verificador HTTP e os percursos funcionais no domínio real.

Referência: https://developers.cloudflare.com/rules/transform/response-header-modification/

## Ativação em Cloudflare Pages

Usar o projeto existente `love-essences-teste`, se a conta confirmar a sua
titularidade, ou um projeto associado ao repositório
`erycafernandees/lovessencesite`. Configuração do build:

```text
Branch de produção: main
Comando: python3 scripts/build_site.py --output _site && python3 scripts/validate_site.py --output _site
Diretório publicado: _site
```

Não publicar a raiz do repositório. Os cabeçalhos de Pages Functions/Workers
exigiriam configuração na resposta; este projeto usa ficheiros estáticos.

1. Publicar primeiro no endereço de revisão do alojamento e confirmar login/MFA,
   catálogo, carrinho, iframe de email e o teste de pagamento isolado.
2. Associar `love-essences.pt` e `www.love-essences.pt` no alojamento. Obter daí os
   registos DNS concretos; não inventar endereços. O DNS atual é gerido na Amen.
3. Guardar os registos DNS atuais. Preservar MX, SPF, DKIM, DMARC e os restantes
   registos de email. Alterar apenas os registos de encaminhamento exigidos pelo
   alojamento. Confirmar emissão do certificado antes da mudança de tráfego.
4. Validar o domínio real com GET: HSTS, nosniff, X-Frame-Options DENY,
   Referrer-Policy no-referrer e CSP com frame-ancestors none. O admin deve receber
   uma única CSP com jsDelivr e Cache-Control no-store. Confirmar navegação,
   imagens, autenticação e pagamentos novamente.
5. Manter o deploy anterior recuperável durante a mudança. Se a verificação
   falhar, restaurar o encaminhamento DNS guardado e investigar no endereço de
   revisão antes de repetir.

Verificação HTTP automática, só de leitura (termina com erro se faltar proteção):

```sh
python3 scripts/verify_host_headers.py --base-url https://love-essences.pt
```

HSTS aplica-se ao hostname visitado. Não se ativa includeSubDomains nem preload
sem confirmar HTTPS em todos os subdomínios. A CSP deixa de permitir JavaScript
inline; estilos inline continuam necessários ao frontend atual.

Referência: https://developers.cloudflare.com/pages/configuration/headers/
