-- FooooooD 食譜本：Supabase 資料庫設定
-- 用法：Supabase 專案 → SQL Editor → New query → 貼上全部 → Run
-- 可以重複執行，不會重複建立

-- 1. 食譜資料表：每道食譜一列，內容整包存在 data（JSON）
create table if not exists public.recipes (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recipes_user_id_idx on public.recipes (user_id);

-- 2. 權限：每個人只能看到、修改自己的食譜
alter table public.recipes enable row level security;

drop policy if exists "只能讀自己的食譜" on public.recipes;
create policy "只能讀自己的食譜" on public.recipes
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "只能新增自己的食譜" on public.recipes;
create policy "只能新增自己的食譜" on public.recipes
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "只能修改自己的食譜" on public.recipes;
create policy "只能修改自己的食譜" on public.recipes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "只能刪除自己的食譜" on public.recipes;
create policy "只能刪除自己的食譜" on public.recipes
  for delete to authenticated using (user_id = auth.uid());

-- 3. 照片儲存空間（不公開），每個人的照片放在以自己 user id 命名的資料夾
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recipe-images', 'recipe-images', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "只能讀自己的照片" on storage.objects;
create policy "只能讀自己的照片" on storage.objects
  for select to authenticated
  using (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "只能上傳自己的照片" on storage.objects;
create policy "只能上傳自己的照片" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "只能刪除自己的照片" on storage.objects;
create policy "只能刪除自己的照片" on storage.objects
  for delete to authenticated
  using (bucket_id = 'recipe-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- 4. 購物清單

create table if not exists public.shopping_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  amount text not null default '',
  done boolean not null default false,
  recipe_id uuid,           -- 從哪道食譜加進來的（可以沒有）
  recipe_title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists shopping_items_user_id_idx on public.shopping_items (user_id);

-- 權限：每個人只能看到、修改自己的購物清單
alter table public.shopping_items enable row level security;

drop policy if exists "只能讀自己的購物清單" on public.shopping_items;
create policy "只能讀自己的購物清單" on public.shopping_items
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "只能新增自己的購物清單" on public.shopping_items;
create policy "只能新增自己的購物清單" on public.shopping_items
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "只能修改自己的購物清單" on public.shopping_items;
create policy "只能修改自己的購物清單" on public.shopping_items
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "只能刪除自己的購物清單" on public.shopping_items;
create policy "只能刪除自己的購物清單" on public.shopping_items
  for delete to authenticated using (user_id = auth.uid());
