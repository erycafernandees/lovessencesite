# Cabeçalhos HTTP — Love Essences

O build escreve `_site/_headers` a partir de `scripts/hosting_security.py`, que
também produz a CSP dos documentos HTML. O GitHub Pages atual ignora `_headers`:
publicar o ficheiro não ativa os cabeçalhos no domínio real.

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
