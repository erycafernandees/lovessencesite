insert into public.products (code, name, category, image_path, metadata) values
('bloom','Bloom','Coleção Assinatura','assets/products/bloom-mini-5.jpg','{"discount_group":"signature"}'),
('aurora','Aurora','Coleção Assinatura','assets/products/aurora.jpg','{"discount_group":"signature"}'),
('serenata','Serenata','Coleção Assinatura','assets/products/serenata.jpg','{"discount_group":"signature"}'),
('diamante','Diamante','Coleção Assinatura','assets/products/diamante-v2.jpg','{"discount_group":"signature"}'),
('prisma','Prisma','Coleção Assinatura','assets/products/prisma.jpg','{"discount_group":"signature"}'),
('nala','Nala','Coleção Assinatura','assets/products/nala.jpg','{"discount_group":"signature"}'),
('aura','Aura','Coleção Assinatura','assets/products/pequeno-diamante.jpg','{"discount_group":"signature"}'),
('essencia_amor','Essência do Amor','Coleção Memórias','assets/products/essencia-amor-m2.jpg','{"discount_group":"memories"}'),
('pensar_em_ti','Pensar em Ti','Coleção Memórias','assets/products/pensar-em-ti.jpg','{"discount_group":"memories"}'),
('lembrei_me_de_ti','Lembrei-me de Ti','Coleção Memórias','assets/products/lembrei-me-de-ti.jpg','{"discount_group":"memories"}'),
('mini_difusor','Mini Difusor','Lembranças para Eventos','assets/products/mini-difusor4.jpg','{"discount_group":"adult_event"}'),
('aroma_em_viagem','Aroma em Viagem','Lembranças para Eventos','assets/products/aroma-em-viagem.jpg','{"discount_group":"adult_event"}'),
('brinde_perfeito','Brinde Perfeito','Lembranças para Eventos','assets/products/brinde-perfeito.jpg','{"discount_group":"adult_event"}'),
('trouxinha_aromatica','Trouxinha Aromática','Lembranças para Eventos','assets/products/trouxinha-aromatica.jpg','{"discount_group":"adult_event"}'),
('bem_querer','Bem-Querer','Lembranças para Eventos','assets/products/bem-querer.jpg','{"discount_group":"adult_event"}'),
('mini_difusor_sabonete','Mini Difusor + Mini Sabonete','Lembranças para Eventos','assets/products/mini-difusor-mais-mini-sabonete.jpg','{"discount_group":"adult_event"}'),
('sopros_alegria','Sopros de Alegria','Lembranças para Eventos','assets/products/sopros-de-alegria-soft.jpg','{"discount_group":"child_event"}'),
('luz_serena','Luz Serena','Lembranças para Eventos','assets/products/luz-serena.png','{"discount_group":"adult_event"}'),
('doce_luz','Doce Luz','Lembranças para Eventos','assets/products/doce-luz.png','{"discount_group":"adult_event"}'),
('memoria_perfumada','Memória Perfumada','Lembranças para Eventos','assets/products/memoria-perfumada.png','{"discount_group":"adult_event"}'),
('bilhete_perfumado','Bilhete Perfumado','Lembranças para Eventos','assets/products/bilhete-perfumado.png','{"discount_group":"child_event"}'),
('laco_memoria','Laço de Memória','Lembranças para Eventos','assets/products/laco-de-memoria.jpg','{"discount_group":"adult_event"}'),
('pequeno_artista','Pequeno Artista','Para os Mais Pequeninos','assets/products/pequeno-artista.jpg','{"discount_group":"child_event"}'),
('momento_criativo','Momento Criativo','Para os Mais Pequeninos','assets/products/momento-criativo.jpg','{"discount_group":"child_event"}'),
('caixinha_arte','Caixinha de Arte','Para os Mais Pequeninos','assets/products/caixinha-de-arte.jpg','{"discount_group":"child_event"}'),
('miminho_doce','Miminho Doce','Para os Mais Pequeninos','assets/products/miminho-doce-cone.jpg','{"discount_group":"child_event"}')
on conflict (code) do update set name=excluded.name, category=excluded.category, image_path=excluded.image_path, metadata=excluded.metadata;

with variants(product_code, code, label, cents, minimum_quantity) as (values
('bloom','bloom:mini','Mini',1800,1),('bloom','bloom:m','M',4490,1),('bloom','bloom:l','L',6000,1),
('aurora','aurora:default','Único',2500,1),('serenata','serenata:default','Único',3000,1),
('diamante','diamante:default','Único',2100,1),('prisma','prisma:default','Único',2500,1),
('nala','nala:default','Único',1800,1),('aura','aura:default','Único',1800,1),
('essencia_amor','essencia_amor:s','S',2500,1),('essencia_amor','essencia_amor:m','M',3500,1),('essencia_amor','essencia_amor:l','L',5000,1),
('pensar_em_ti','pensar_em_ti:s','S',2990,1),('pensar_em_ti','pensar_em_ti:m','M',3990,1),('pensar_em_ti','pensar_em_ti:l','L',5500,1),
('lembrei_me_de_ti','lembrei_me_de_ti:default','Único',1200,1),
('mini_difusor','mini_difusor:30ml','30 ml',350,1),('mini_difusor','mini_difusor:50ml','50 ml',490,1),
('aroma_em_viagem','aroma_em_viagem:default','Único',300,1),
('brinde_perfeito','brinde_perfeito:porto','Vinho do Porto',400,1),('brinde_perfeito','brinde_perfeito:beirao','Licor Beirão',400,1),
('trouxinha_aromatica','trouxinha_aromatica:default','Único',500,1),('bem_querer','bem_querer:default','Único',400,1),
('mini_difusor_sabonete','mini_difusor_sabonete:default','Único',500,1),('sopros_alegria','sopros_alegria:default','Único',150,12),
('luz_serena','luz_serena:default','Único',350,10),('doce_luz','doce_luz:default','Único',350,15),
('memoria_perfumada','memoria_perfumada:simples','Decoração simples',350,10),('memoria_perfumada','memoria_perfumada:completa','Laço + pingente + tag',400,10),('bilhete_perfumado','bilhete_perfumado:default','Único',200,12),
('laco_memoria','laco_memoria:default','Único',490,1),('pequeno_artista','pequeno_artista:default','Único',300,1),
('momento_criativo','momento_criativo:default','Único',400,1),('caixinha_arte','caixinha_arte:default','Único',590,1),
('miminho_doce','miminho_doce:laco_marshmallows','Laço de marshmallows',100,1),('miminho_doce','miminho_doce:cone_miminhos','Cone de miminhos',200,1),('miminho_doce','miminho_doce:espetada_alegria','Espetada de alegria',200,1)
)
insert into public.product_variants(product_id, code, label, unit_amount, minimum_quantity)
select p.id, v.code, v.label, v.cents, v.minimum_quantity
from variants v join public.products p on p.code=v.product_code
on conflict (code) do update set label=excluded.label, unit_amount=excluded.unit_amount, minimum_quantity=excluded.minimum_quantity, active=true;

with addons(product_code, code, label, cents) as (values
  ('aurora','aurora:custom_text','Personalização com texto',150),
  ('essencia_amor','essencia_amor:custom_text','Personalização com texto',150),
  ('aroma_em_viagem','aroma_em_viagem:event_card','Cartão personalizado',50)
)
insert into public.product_addons(product_id, code, label, unit_amount)
select p.id, a.code, a.label, a.cents
from addons a join public.products p on p.code=a.product_code
on conflict (code) do update set label=excluded.label, unit_amount=excluded.unit_amount, active=true;
