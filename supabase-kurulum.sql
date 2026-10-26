-- =====================================================================
--  Pazaryeri Fiyatlandırma — Supabase veritabanı kurulumu
--  Supabase panelinde: SQL Editor > New query > bu dosyanın TAMAMINI
--  yapıştırın > Run. Bir kez çalıştırmanız yeterli.
-- =====================================================================

-- ---------- Tablolar ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '',
  role text not null default 'user' check (role in ('admin', 'user')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id bigint generated always as identity primary key,
  name text not null check (length(trim(name)) > 0),
  sku text not null default '',
  cost numeric not null check (cost > 0),
  vat numeric not null default 0 check (vat >= 0),
  profit numeric not null default 0 check (profit >= 0),
  cargo numeric not null default 0 check (cargo >= 0),
  commission numeric not null default 0 check (commission >= 0 and commission < 100),
  overrides jsonb not null default '{}'::jsonb,
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

-- ---------- Yetki yardımcıları ----------
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- ---------- Yeni kayıt olan kullanıcı ----------
-- İlk kayıt olan kişi otomatik olarak aktif YÖNETİCİ olur.
-- Sonrakiler "onay bekliyor" durumunda başlar; yönetici aktifleştirir.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  first_user boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, email, name, role, active)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)),
    case when first_user then 'admin' else 'user' end,
    first_user
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- En az bir aktif yönetici kalmalı
create or replace function public.keep_one_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'admin' and old.active and (new.role <> 'admin' or not new.active) then
    if not exists (select 1 from public.profiles where id <> old.id and role = 'admin' and active) then
      raise exception 'En az bir aktif yönetici kalmalı';
    end if;
  end if;
  -- e-posta ve id kullanıcı tarafından değiştirilemez
  new.id := old.id;
  new.email := old.email;
  return new;
end;
$$;

drop trigger if exists profiles_keep_admin on public.profiles;
create trigger profiles_keep_admin
  before update on public.profiles
  for each row execute function public.keep_one_admin();

-- Ürünü kimin, ne zaman güncellediği otomatik yazılır
create or replace function public.stamp_product()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select name from public.profiles where id = auth.uid()), '');
  return new;
end;
$$;

drop trigger if exists products_stamp on public.products;
create trigger products_stamp
  before insert or update on public.products
  for each row execute function public.stamp_product();

-- ---------- Satır güvenliği (RLS) ----------
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.settings enable row level security;

drop policy if exists "profil_oku" on public.profiles;
create policy "profil_oku" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "profil_yonetici_gunceller" on public.profiles;
create policy "profil_yonetici_gunceller" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "urun_oku" on public.products;
create policy "urun_oku" on public.products
  for select to authenticated using (public.is_active_user());

drop policy if exists "urun_ekle" on public.products;
create policy "urun_ekle" on public.products
  for insert to authenticated with check (public.is_active_user());

drop policy if exists "urun_guncelle" on public.products;
create policy "urun_guncelle" on public.products
  for update to authenticated using (public.is_active_user()) with check (public.is_active_user());

drop policy if exists "urun_sil" on public.products;
create policy "urun_sil" on public.products
  for delete to authenticated using (public.is_active_user());

drop policy if exists "ayar_oku" on public.settings;
create policy "ayar_oku" on public.settings
  for select to authenticated using (public.is_active_user());

drop policy if exists "ayar_yonetici_gunceller" on public.settings;
create policy "ayar_yonetici_gunceller" on public.settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- Tablo yetkileri (giriş yapmamış ziyaretçi hiçbir şey göremez)
revoke all on public.profiles, public.products, public.settings from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.products to authenticated;
grant select, update on public.settings to authenticated;

-- ---------- Başlangıç pazaryeri ayarları (Excel'deki değerler) ----------
insert into public.settings (key, value) values ('pricing', '{"rounding":"none","marketplaces":[{"id":"trendyol","name":"Trendyol","active":true,"mode":"tiers","fee":12,"tiers":[{"max":200,"cargo":47},{"max":350,"cargo":85}]},{"id":"hepsiburada","name":"Hepsiburada","active":true,"mode":"tiers","fee":0,"tiers":[{"max":200,"cargo":53},{"max":400,"cargo":92}]},{"id":"n11","name":"N11","active":true,"mode":"tiers","fee":5,"tiers":[{"max":150,"cargo":63},{"max":300,"cargo":100}]},{"id":"amazon","name":"Amazon","active":true,"mode":"tiers","fee":0,"tiers":[]},{"id":"pazarama","name":"Pazarama","active":true,"mode":"tiers","fee":11,"tiers":[{"max":150,"cargo":58},{"max":300,"cargo":95}]},{"id":"ciceksepeti","name":"Çiçeksepeti","active":true,"mode":"tiers","fee":6.5,"tiers":[]},{"id":"idefix","name":"İdefix","active":true,"mode":"tiers","fee":10,"tiers":[{"max":150,"cargo":33},{"max":250,"cargo":63}]},{"id":"koctas","name":"Koçtaş","active":true,"mode":"tiers","fee":10,"tiers":[{"max":300,"cargo":72}]},{"id":"eptt","name":"ePTT","active":true,"mode":"tiers","fee":6,"tiers":[]},{"id":"temel","name":"Temel (kargo paylı)","active":true,"mode":"shared","fee":0,"threshold":400,"tiers":[]}]}'::jsonb)
on conflict (key) do nothing;
