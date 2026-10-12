create table if not exists public.account_profiles (
    user_id uuid primary key references auth.users (id) on delete cascade,
    username text not null,
    username_key text not null unique,
    role text not null check (role in ('admin', 'user')),
    created_at timestamptz not null default now()
);

alter table public.account_profiles enable row level security;

revoke all on table public.account_profiles from anon, authenticated;

create or replace function public.claim_first_admin(p_user_id uuid, p_username text, p_username_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if auth.role() <> 'service_role' then
        raise exception 'forbidden';
    end if;

    perform pg_advisory_xact_lock(845129, 1);

    if exists (
        select 1 from public.account_profiles where role = 'admin'
    ) then
        raise exception 'first admin already configured';
    end if;

    insert into public.account_profiles (user_id, username, username_key, role)
    values (p_user_id, p_username, p_username_key, 'admin');
end;
$$;

revoke all on function public.claim_first_admin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_first_admin(uuid, text, text) to service_role;
