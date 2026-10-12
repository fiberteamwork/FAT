(function () {
    'use strict';

    const SESSION_LABEL = 'eastRegionalSession';
    let authClient;
    let activeAccount = null;
    let resolveReady;
    const ready = new Promise(resolve => {
        resolveReady = resolve;
    });
    window.dashboardAuthReady = ready;

    const byId = id => document.getElementById(id);

    let mapLoadPromise = null;

    function loadMapApplication() {
        if (mapLoadPromise) return mapLoadPromise;

        const scripts = [
            'resources/qgis2web_expressions.js',
            'resources/xlsx-lite.js',
            'resources/functions.js',
            'resources/ol.js',
            'resources/ol-layerswitcher.js',
            'resources/photon-geocoder-autocomplete.min.js',
            'resources/olms.js',
            'layers/SIDOARJO_1.js',
            'layers/Denpasar_1.js',
            'layers/surabaya_2.js',
            'styles/SIDOARJO_1_style.js',
            'styles/surabaya_2_style.js',
            'layers/layers.js',
            'resources/Autolinker.min.js',
            'resources/qgis2web.js',
            'https://cdn.jsdelivr.net/npm/chart.js',
            'resources/customer-map.js?v=20261012.13'
        ];

        const loadingMessage = byId('map-loading-message');
        if (loadingMessage) loadingMessage.textContent = 'Menyiapkan peta dan data FAT...';
        window.customerDataPreload = fetch('./data/Data FAT Full.xlsx?v=20261012.1', {
            cache: 'force-cache'
        }).then(response => {
            if (!response.ok) throw new Error('Data FAT gagal dimuat. HTTP ' + response.status);
            return response.arrayBuffer();
        }).catch(error => {
            console.warn('[MAP] Prefetch data FAT gagal; akan dicoba kembali saat peta siap.', error);
            return null;
        });
        mapLoadPromise = Promise.all(scripts.map(src => new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.async = false;
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Gagal memuat komponen peta: ' + src));
            document.body.appendChild(script);
        }))).catch(error => {
            console.error('[MAP] Pemuatan peta gagal:', error);
            if (loadingMessage) {
                loadingMessage.textContent = 'Peta gagal dimuat. Periksa koneksi lalu muat ulang halaman.';
            }
            return null;
        });

        return mapLoadPromise;
    }

    function setMessage(id, message) {
        const element = byId(id);
        if (element) element.textContent = message;
    }

    function getErrorMessage(error, fallback) {
        return error && error.message ? error.message : fallback;
    }

    async function accountApi(action, values) {
        const { data, error } = await authClient.functions.invoke('account-api', {
            body: { action, ...(values || {}) }
        });

        if (error) {
            let responseData = data;
            if (!responseData && error.context instanceof Response) {
                responseData = await error.context.clone().json().catch(() => null);
            }
            throw new Error(responseData && responseData.error
                ? responseData.error
                : error.message || 'Layanan akun tidak dapat dihubungi.');
        }
        if (!data || data.error) {
            throw new Error(data && data.error ? data.error : 'Respons layanan akun tidak valid.');
        }
        return data;
    }

    function loginAccount(account) {
        activeAccount = { username: account.username, role: account.role };
        sessionStorage.setItem(SESSION_LABEL, account.username);
        byId('auth-session-label').textContent =
            `${activeAccount.username} ${activeAccount.role === 'admin' ? 'Admin' : 'User'}`;
        byId('auth-manage-users').hidden = activeAccount.role !== 'admin';
        byId('auth-gate').hidden = true;
        document.body.classList.add('auth-ready');
        const mapLoading = byId('map-loading');
        if (mapLoading) {
            mapLoading.hidden = window.customerMapReady === true;
        }
        resolveReady(activeAccount);
        loadMapApplication();
    }

    function showLogin() {
        activeAccount = null;
        sessionStorage.removeItem(SESSION_LABEL);
        document.body.classList.remove('auth-ready');
        byId('auth-gate').hidden = false;
        byId('auth-setup-view').hidden = true;
        byId('auth-login-view').hidden = false;
        byId('user-management-modal').hidden = true;
        byId('change-password-modal').hidden = true;
        byId('auth-login-username').focus();
    }

    function showSetup() {
        byId('auth-subtitle').textContent = 'Buat admin pertama untuk digunakan bersama di semua perangkat.';
        byId('auth-setup-view').hidden = false;
        byId('auth-login-view').hidden = true;
        byId('auth-setup-username').focus();
    }

    function renderAccounts(accounts) {
        const list = byId('auth-account-list');
        list.replaceChildren();
        accounts
            .sort((left, right) => left.username.localeCompare(right.username))
            .forEach(account => {
                const item = document.createElement('li');
                const name = document.createElement('span');
                const role = document.createElement('strong');
                name.textContent = account.username;
                role.textContent = account.role === 'admin' ? 'Admin' : 'User';
                item.append(name, role);
                list.appendChild(item);
            });
    }

    async function refreshAccounts() {
        const result = await accountApi('list');
        renderAccounts(result.accounts);
    }

    async function signIn(username, password) {
        const email = `${username.trim().toLowerCase()}@accounts.eastregional.invalid`;
        const { error } = await authClient.auth.signInWithPassword({ email, password });
        if (error) throw new Error('Username atau password salah.');
        const result = await accountApi('me');
        loginAccount(result.account);
    }

    function bindEvents() {
        byId('auth-setup-form').addEventListener('submit', async event => {
            event.preventDefault();
            const button = event.currentTarget.querySelector('button[type="submit"]');
            button.disabled = true;
            setMessage('auth-setup-message', '');
            try {
                const username = byId('auth-setup-username').value;
                const password = byId('auth-setup-password').value;
                const setupKey = byId('auth-setup-key').value;
                await accountApi('setup', { username, password, setupKey });
                await signIn(username, password);
            } catch (error) {
                const message = getErrorMessage(error, 'Admin pertama gagal dibuat.');
                if (message.includes('sudah dibuat')) {
                    byId('auth-setup-view').hidden = true;
                    byId('auth-login-view').hidden = false;
                    setMessage('auth-login-message', message);
                    byId('auth-login-username').focus();
                } else {
                    setMessage('auth-setup-message', message);
                }
            } finally {
                button.disabled = false;
            }
        });

        byId('auth-login-form').addEventListener('submit', async event => {
            event.preventDefault();
            const button = byId('auth-login-button');
            button.disabled = true;
            setMessage('auth-login-message', '');
            try {
                await signIn(byId('auth-login-username').value, byId('auth-login-password').value);
            } catch (error) {
                setMessage('auth-login-message', getErrorMessage(error, 'Login gagal.'));
            } finally {
                button.disabled = false;
            }
        });

        byId('auth-logout').addEventListener('click', async () => {
            const { error } = await authClient.auth.signOut();
            if (error) {
                console.error('[AUTH] Logout gagal:', error);
                setMessage('auth-login-message', 'Logout gagal. Silakan coba lagi.');
                return;
            }
            showLogin();
        });

        byId('auth-change-password').addEventListener('click', () => {
            setMessage('change-password-message', '');
            byId('change-password-form').reset();
            byId('change-password-modal').hidden = false;
            byId('auth-current-password').focus();
        });
        byId('change-password-close').addEventListener('click', () => {
            byId('change-password-modal').hidden = true;
        });
        byId('change-password-modal').addEventListener('click', event => {
            if (event.target === byId('change-password-modal')) {
                byId('change-password-modal').hidden = true;
            }
        });
        byId('change-password-form').addEventListener('submit', async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const button = byId('change-password-submit');
            const newPassword = byId('auth-new-password').value;
            button.disabled = true;
            setMessage('change-password-message', '');
            try {
                if (newPassword !== byId('auth-confirm-password').value) {
                    throw new Error('Konfirmasi password baru tidak sama.');
                }
                await accountApi('change-password', {
                    currentPassword: byId('auth-current-password').value,
                    newPassword
                });
                form.reset();
                setMessage('change-password-message', 'Password berhasil diubah.');
            } catch (error) {
                setMessage('change-password-message', getErrorMessage(error, 'Password gagal diubah.'));
            } finally {
                button.disabled = false;
            }
        });

        byId('auth-manage-users').addEventListener('click', async () => {
            if (activeAccount && activeAccount.role === 'admin') {
                setMessage('admin-user-message', '');
                try {
                    await refreshAccounts();
                    byId('user-management-modal').hidden = false;
                    byId('admin-new-username').focus();
                } catch (error) {
                    setMessage('admin-user-message', getErrorMessage(error, 'Daftar akun gagal dimuat.'));
                }
            }
        });
        byId('user-management-close').addEventListener('click', () => {
            byId('user-management-modal').hidden = true;
        });
        byId('user-management-modal').addEventListener('click', event => {
            if (event.target === byId('user-management-modal')) {
                byId('user-management-modal').hidden = true;
            }
        });

        byId('admin-user-form').addEventListener('submit', async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const button = byId('admin-user-submit');
            button.disabled = true;
            setMessage('admin-user-message', '');
            try {
                await accountApi('create', {
                    username: byId('admin-new-username').value,
                    password: byId('admin-new-password').value,
                    role: byId('admin-new-role').value
                });
                form.reset();
                setMessage('admin-user-message', 'Akun bersama berhasil ditambahkan.');
                await refreshAccounts();
            } catch (error) {
                setMessage('admin-user-message', getErrorMessage(error, 'Akun gagal ditambahkan.'));
            } finally {
                button.disabled = false;
            }
        });
    }

    async function initialize() {
        bindEvents();
        const config = window.EAST_REGIONAL_SUPABASE;
        if (!config || !config.url || !config.anonKey ||
            config.url.includes('YOUR-PROJECT') || config.anonKey.includes('YOUR-ANON-KEY')) {
            const message = 'Backend akun belum dikonfigurasi. Isi URL dan anon key Supabase di resources/supabase-config.js.';
            byId('auth-subtitle').textContent = message;
            setMessage('auth-login-message', message);
            byId('auth-login-view').hidden = false;
            console.error('[AUTH] Konfigurasi Supabase belum diisi.');
            return;
        }

        try {
            authClient = window.supabase.createClient(config.url, config.anonKey, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
            });
            const { data: { session }, error } = await authClient.auth.getSession();
            if (error) throw error;
            if (session) {
                try {
                    const result = await accountApi('me');
                    loginAccount(result.account);
                    return;
                } catch (error) {
                    await authClient.auth.signOut();
                    console.warn('[AUTH] Sesi sebelumnya tidak berlaku:', error);
                }
            }

            const status = await accountApi('status');
            if (status.hasAccounts) {
                byId('auth-login-view').hidden = false;
            } else {
                showSetup();
            }
        } catch (error) {
            const message = getErrorMessage(error, 'Layanan akun gagal dimuat.');
            byId('auth-subtitle').textContent = message;
            setMessage('auth-login-message', message);
            byId('auth-login-view').hidden = false;
            console.error('[AUTH] Inisialisasi autentikasi gagal:', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
