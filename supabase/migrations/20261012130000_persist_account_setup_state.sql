create table if not exists public.account_setup_state (
    id integer primary key check (id = 1),
    completed boolean not null default false,
    completed_at timestamptz,
    admin_user_id uuid references auth.users (id) on delete set null
);

alter table public.account_setup_state enable row level security;
revoke all on table public.account_setup_state from anon, authenticated;

insert into public.account_setup_state (id, completed, completed_at, admin_user_id)
select
    1,
    exists (select 1 from public.account_profiles where role = 'admin'),
    (select max(created_at) from public.account_profiles where role = 'admin'),
    (
        select user_id
        from public.account_profiles
        where role = 'admin'
        order by created_at
        limit 1
    )
on conflict (id) do nothing;

create or replace function public.claim_first_admin(p_user_id uuid, p_username text, p_username_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    setup_is_complete boolean;
begin
    if auth.role() <> 'service_role' then
        raise exception 'forbidden';
    end if;

    select completed
    into setup_is_complete
    from public.account_setup_state
    where id = 1
    for update;

    if not found then
        raise exception 'account setup state is not initialized';
    end if;

    if setup_is_complete or exists (
        select 1 from public.account_profiles where role = 'admin'
    ) then
        raise exception 'first admin already configured';
    end if;

    insert into public.account_profiles (user_id, username, username_key, role)
    values (p_user_id, p_username, p_username_key, 'admin');

    update public.account_setup_state
    set completed = true,
        completed_at = now(),
        admin_user_id = p_user_id
    where id = 1;
end;
$$;

revoke all on function public.claim_first_admin(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_first_admin(uuid, text, text) to service_role;
