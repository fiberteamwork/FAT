import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
};

class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function response(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function normalizeUsername(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
}

function validateCredentials(username: string, password: unknown): asserts password is string {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
        throw new ApiError(400, 'Username harus 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.');
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
        throw new ApiError(400, 'Password harus 8-256 karakter.');
    }
}

function accountEmail(usernameKey: string) {
    return `${usernameKey}@accounts.eastregional.invalid`;
}

Deno.serve(async request => {
    if (request.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
        return response({ error: 'Metode tidak diizinkan.' }, 405);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        console.error('[account-api] Konfigurasi environment Supabase tidak lengkap.');
        return response({ error: 'Konfigurasi layanan akun belum lengkap.' }, 500);
    }

    let input: Record<string, unknown>;
    try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Invalid request body');
        }
        input = parsed;
    } catch {
        return response({ error: 'Isi permintaan tidak valid.' }, 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false }
    });

    try {
        const action = input.action;
        if (action === 'status') {
            const { data: setupState, error: setupError } = await adminClient
                .from('account_setup_state')
                .select('completed')
                .eq('id', 1)
                .maybeSingle();
            if (setupError) throw setupError;
            if (!setupState) throw new Error('Status setup akun belum diinisialisasi.');

            const { count, error } = await adminClient
                .from('account_profiles')
                .select('user_id', { count: 'exact', head: true });
            if (error) throw error;
            return response({ hasAccounts: setupState.completed || (count || 0) > 0 });
        }

        if (action === 'setup') {
            const username = normalizeUsername(input.username);
            const password = input.password;
            const setupKey = input.setupKey;
            const expectedSetupKey = Deno.env.get('INITIAL_ADMIN_SETUP_KEY');
            if (!expectedSetupKey) {
                console.error('[account-api] INITIAL_ADMIN_SETUP_KEY belum dikonfigurasi.');
                throw new ApiError(503, 'Setup admin pertama belum dikonfigurasi oleh pemilik aplikasi.');
            }
            if (typeof setupKey !== 'string' || setupKey.length !== expectedSetupKey.length || setupKey !== expectedSetupKey) {
                throw new ApiError(403, 'Kunci setup tidak sesuai. Minta kunci kepada pemilik aplikasi.');
            }
            validateCredentials(username, password);
            const usernameKey = username.toLowerCase();

            const { data: setupState, error: setupError } = await adminClient
                .from('account_setup_state')
                .select('completed')
                .eq('id', 1)
                .maybeSingle();
            if (setupError) throw setupError;
            if (!setupState) throw new Error('Status setup akun belum diinisialisasi.');

            const { count, error: countError } = await adminClient
                .from('account_profiles')
                .select('user_id', { count: 'exact', head: true });
            if (countError) throw countError;
            if (setupState.completed || (count || 0) > 0) {
                throw new ApiError(409, 'Admin pertama sudah dibuat. Silakan masuk dengan akun yang tersedia.');
            }

            const { data: created, error: createError } = await adminClient.auth.admin.createUser({
                email: accountEmail(usernameKey),
                password,
                email_confirm: true,
                user_metadata: { username }
            });
            if (createError || !created.user) {
                if (createError?.message.toLowerCase().includes('already')) {
                    throw new ApiError(409, 'Username sudah digunakan.');
                }
                throw createError || new Error('Akun admin gagal dibuat.');
            }

            const { error: claimError } = await adminClient.rpc('claim_first_admin', {
                p_user_id: created.user.id,
                p_username: username,
                p_username_key: usernameKey
            });
            if (claimError) {
                await adminClient.auth.admin.deleteUser(created.user.id);
                if (claimError.message.includes('first admin already configured')) {
                    throw new ApiError(409, 'Admin pertama sudah dibuat. Silakan masuk dengan akun yang tersedia.');
                }
                if (claimError.code === '23505') {
                    throw new ApiError(409, 'Username sudah digunakan.');
                }
                throw claimError;
            }
            return response({ success: true });
        }

        const authorization = request.headers.get('Authorization') || '';
        const accessToken = authorization.replace(/^Bearer\s+/i, '');
        if (!accessToken || accessToken === authorization) {
            throw new ApiError(401, 'Silakan masuk terlebih dahulu.');
        }
        const userClient = createClient(supabaseUrl, anonKey, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data: { user }, error: userError } = await userClient.auth.getUser(accessToken);
        if (userError || !user) throw new ApiError(401, 'Sesi tidak berlaku. Silakan masuk kembali.');

        const { data: profile, error: profileError } = await adminClient
            .from('account_profiles')
            .select('user_id, username, username_key, role')
            .eq('user_id', user.id)
            .maybeSingle();
        if (profileError) throw profileError;
        if (!profile) throw new ApiError(403, 'Akun tidak terdaftar.');

        if (action === 'me') {
            return response({ account: { username: profile.username, role: profile.role } });
        }
        if (action === 'list') {
            if (profile.role !== 'admin') throw new ApiError(403, 'Hanya admin yang dapat melihat daftar akun.');
            const { data: accounts, error } = await adminClient
                .from('account_profiles')
                .select('username, role')
                .order('username');
            if (error) throw error;
            return response({ accounts: accounts || [] });
        }
        if (action === 'create') {
            if (profile.role !== 'admin') throw new ApiError(403, 'Hanya admin yang dapat menambahkan akun.');
            const username = normalizeUsername(input.username);
            const password = input.password;
            const role = input.role;
            validateCredentials(username, password);
            if (role !== 'admin' && role !== 'user') throw new ApiError(400, 'Peran akun tidak valid.');
            const usernameKey = username.toLowerCase();
            const { data: created, error: createError } = await adminClient.auth.admin.createUser({
                email: accountEmail(usernameKey),
                password,
                email_confirm: true,
                user_metadata: { username }
            });
            if (createError || !created.user) {
                if (createError?.message.toLowerCase().includes('already')) {
                    throw new ApiError(409, 'Username sudah digunakan.');
                }
                throw createError || new Error('Akun gagal dibuat.');
            }
            const { error: insertError } = await adminClient.from('account_profiles').insert({
                user_id: created.user.id,
                username,
                username_key: usernameKey,
                role
            });
            if (insertError) {
                await adminClient.auth.admin.deleteUser(created.user.id);
                if (insertError.code === '23505') throw new ApiError(409, 'Username sudah digunakan.');
                throw insertError;
            }
            return response({ success: true });
        }
        if (action === 'change-password') {
            const currentPassword = input.currentPassword;
            const newPassword = input.newPassword;
            if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
                throw new ApiError(400, 'Masukkan password saat ini.');
            }
            if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 256) {
                throw new ApiError(400, 'Password baru harus 8-256 karakter.');
            }
            const { error: verifyError } = await userClient.auth.signInWithPassword({
                email: accountEmail(profile.username_key),
                password: currentPassword
            });
            if (verifyError) throw new ApiError(400, 'Password saat ini tidak sesuai.');
            const { error } = await adminClient.auth.admin.updateUserById(user.id, { password: newPassword });
            if (error) throw error;
            return response({ success: true });
        }

        throw new ApiError(400, 'Aksi akun tidak dikenal.');
    } catch (error) {
        if (error instanceof ApiError) return response({ error: error.message }, error.status);
        console.error('[account-api] Permintaan gagal:', error);
        return response({ error: 'Terjadi kesalahan pada layanan akun.' }, 500);
    }
});
