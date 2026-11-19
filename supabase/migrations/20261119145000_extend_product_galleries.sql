alter table public.product_gallery_images
  drop constraint product_gallery_images_product_id_check,
  drop constraint product_gallery_path,
  add constraint product_gallery_path check (
    split_part(object_path,'/',1) = product_id
    and object_path ~ '^[a-z][a-z0-9_]+/[a-f0-9-]{36}[.](jpg|jpeg|png|webp)$'
  );

alter policy "Owner gallery object upload" on storage.objects
  with check (
    bucket_id = 'product-gallery'
    and public.is_admin(array['owner','manager'])
    and name ~ '^[a-z][a-z0-9_]+/[a-f0-9-]{36}[.](jpg|jpeg|png|webp)$'
  );
