-- 購物清單功能（2026-09-25 新增）
-- 用法：Supabase 專案 → SQL Editor → New query → 貼上全部 → Run
-- 可以重複執行，不會重複建立

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
