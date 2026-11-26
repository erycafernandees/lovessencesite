-- Apply only after checking existing records in staging. No data is deleted.
alter table public.order_items add constraint order_items_quantity_bounds check (quantity between 1 and 10000 and (product_id is null or quantity <= 500)) not valid;
alter table public.quote_items add constraint quote_items_quantity_bounds check (quantity between 1 and 10000) not valid;
