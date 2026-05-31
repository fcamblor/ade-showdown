-- Sync the features catalog with `src/data/features.ts`.
--
-- Adds feature IDs introduced after the previous catalog sync:
--   - ui-commit

insert into public.features_catalog (id) values
  ('ui-commit')
on conflict (id) do nothing;
