-- Galerias públicas dos artigos de Natal. A escrita exige perfil owner/manager e MFA (aal2).
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('product-gallery','product-gallery',true,10485760,ARRAY['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create table if not exists public.product_gallery_images (
  id uuid primary key default gen_random_uuid(),
  product_id text not null check (product_id in (
    'natal_sagrada_familia','natal_vela_abobora','natal_vila_encantada','natal_carrossel'
  )),
  object_path text not null unique,
  sort_order integer not null default 0 check (sort_order between 0 and 1000),
  created_at timestamptz not null default now(),
  constraint product_gallery_path check (
    split_part(object_path,'/',1)=product_id
    and object_path ~ '^(natal_sagrada_familia|natal_vela_abobora|natal_vila_encantada|natal_carrossel)/[a-f0-9-]{36}[.](jpg|jpeg|png|webp)$'
  )
);
alter table public.product_gallery_images enable row level security;
grant select on public.product_gallery_images to anon,authenticated;
grant insert,delete on public.product_gallery_images to authenticated;

do $policies$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_gallery_images' and policyname='Public can read catalog product galleries') then
    create policy "Public can read catalog product galleries" on public.product_gallery_images
      for select to anon,authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_gallery_images' and policyname='Owners and managers can add gallery images') then
    create policy "Owners and managers can add gallery images" on public.product_gallery_images
      for insert to authenticated with check (public.is_admin(ARRAY['owner','manager']));
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='product_gallery_images' and policyname='Owners and managers can remove gallery images') then
    create policy "Owners and managers can remove gallery images" on public.product_gallery_images
      for delete to authenticated using (public.is_admin(ARRAY['owner','manager']));
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='Owner gallery object read') then
    create policy "Owner gallery object read" on storage.objects
      for select to authenticated using (bucket_id='product-gallery' and public.is_admin(ARRAY['owner','manager']));
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='Owner gallery object upload') then
    create policy "Owner gallery object upload" on storage.objects
      for insert to authenticated with check (
        bucket_id='product-gallery'
        and public.is_admin(ARRAY['owner','manager'])
        and split_part(name,'/',1) in ('natal_sagrada_familia','natal_vela_abobora','natal_vila_encantada','natal_carrossel')
        and name ~ '^(natal_sagrada_familia|natal_vela_abobora|natal_vila_encantada|natal_carrossel)/[a-f0-9-]{36}[.](jpg|jpeg|png|webp)$'
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='Owner gallery object delete') then
    create policy "Owner gallery object delete" on storage.objects
      for delete to authenticated using (bucket_id='product-gallery' and public.is_admin(ARRAY['owner','manager']));
  end if;
end
$policies$;
