-- Recette contrats de services : base Supabase
-- À exécuter une fois dans Supabase > SQL Editor.
-- Principe : journal en AJOUT SEUL. Personne (client comme Be-Cloud) ne peut modifier
-- ni supprimer une entrée depuis le site ; seul le propriétaire du projet Supabase le peut
-- depuis le tableau de bord.

-- 1. Administrateurs Be-Cloud (peuvent répondre aux retours)
create table if not exists public.admins (email text primary key);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where lower(email) = lower(auth.jwt() ->> 'email'))
$$;
grant execute on function public.is_admin() to authenticated;

-- 2. Journal : déplacements de cartes, retours, réponses Be-Cloud
create table if not exists public.entries (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid not null default auth.uid() references auth.users (id),
  user_email  text not null default (auth.jwt() ->> 'email'),
  auteur      text not null check (char_length(auteur) between 1 and 80),
  kind        text not null check (kind in ('retour', 'statut', 'reponse')),
  cas         text check (char_length(cas) <= 20),
  ex          text check (char_length(ex) <= 20),
  statut      text check (statut in ('ok', 'anomalie', 'question', 'remarque')),
  gravite     text check (gravite in ('bloquante', 'majeure', 'mineure')),
  col         text check (col in ('atester', 'encours', 'ok', 'anomalie', 'corrige')),
  etat        text check (etat in ('encours', 'corrige', 'rejete')),
  parent      uuid references public.entries (id),
  commentaire text check (char_length(commentaire) <= 4000),
  capture     text check (char_length(capture) <= 300)
);
create index if not exists entries_created on public.entries (created_at);

alter table public.entries enable row level security;
revoke all on public.entries from anon;
revoke update, delete, truncate on public.entries from authenticated;
grant select, insert on public.entries to authenticated;

drop policy if exists "lecture" on public.entries;
create policy "lecture" on public.entries for select to authenticated using (true);

drop policy if exists "ajout" on public.entries;
create policy "ajout" on public.entries for insert to authenticated
  with check (
    user_id = auth.uid()
    and user_email = (auth.jwt() ->> 'email')
    and (kind <> 'reponse' or public.is_admin())
  );

-- mises à jour en direct
do $$ begin
  alter publication supabase_realtime add table public.entries;
exception when duplicate_object then null; end $$;

-- 3. Captures d'écran (stockage privé, ajout seul)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('captures', 'captures', false, 10485760, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "captures lecture" on storage.objects;
create policy "captures lecture" on storage.objects for select to authenticated
  using (bucket_id = 'captures');

drop policy if exists "captures ajout" on storage.objects;
create policy "captures ajout" on storage.objects for insert to authenticated
  with check (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);

-- 4. Après exécution, ajouter votre adresse Be-Cloud comme administrateur :
-- insert into public.admins (email) values ('votre.adresse@domaine');
