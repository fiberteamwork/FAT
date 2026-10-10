(function () {
    'use strict';

    const DATABASE_NAME = 'east-regional-browser-auth';
    const DATABASE_VERSION = 1;
    const ACCOUNT_STORE = 'accounts';
    const ITERATIONS = 210000;
    const SESSION_KEY = 'eastRegionalSession';
    let database;
    let activeAccount = null;
    let resolveReady;
    const ready = new Promise(resolve => {
        resolveReady = resolve;
    });
    window.dashboardAuthReady = ready;

    const byId = id => document.getElementById(id);

    function setMessage(id, message) {
        const element = byId(id);
        if (element) element.textContent = message;
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('Browser ini tidak mendukung IndexedDB.'));
                return;
            }
            const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(ACCOUNT_STORE)) {
                    db.createObjectStore(ACCOUNT_STORE, { keyPath: 'usernameKey' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Database akun gagal dibuka.'));
        });
    }

    function accountRequest(mode, action) {
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(ACCOUNT_STORE, mode);
            const request = action(transaction.objectStore(ACCOUNT_STORE));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Operasi akun gagal.'));
            transaction.onabort = () => reject(transaction.error || new Error('Transaksi database akun dibatalkan.'));
        });
    }

    function listAccounts() {
        return accountRequest('readonly', store => store.getAll());
    }

    function normalizeUsername(value) {
        return String(value || '').trim();
    }

    function usernameKey(value) {
        return normalizeUsername(value).toLowerCase();
    }

    function validateUsername(value) {
        return /^[a-zA-Z0-9._-]{3,32}$/.test(value);
    }

    function bytesToBase64(bytes) {
        let binary = '';
        bytes.forEach(byte => {
            binary += String.fromCharCode(byte);
        });
        return btoa(binary);
    }

    function base64ToBytes(value) {
        return Uint8Array.from(atob(value), character => character.charCodeAt(0));
    }

    async function derivePasswordHash(password, salt) {
        if (!window.crypto?.subtle) {
            throw new Error('Web Crypto tidak tersedia. Buka aplikasi melalui HTTPS atau localhost.');
        }
        const passwordKey = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await crypto.subtle.deriveBits({
            name: 'PBKDF2',
            salt,
            iterations: ITERATIONS,
            hash: 'SHA-256'
        }, passwordKey, 256);
        return new Uint8Array(bits);
    }

    async function createAccount(username, password, role) {
        const cleanUsername = normalizeUsername(username);
        const key = usernameKey(cleanUsername);
        if (!validateUsername(cleanUsername)) {
            throw new Error('Username harus 3-32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.');
        }
        if (password.length < 8) {
            throw new Error('Password harus minimal 8 karakter.');
        }
        if (role !== 'admin' && role !== 'user') {
            throw new Error('Peran akun tidak valid.');
        }

        const salt = crypto.getRandomValues(new Uint8Array(16));
        const passwordHash = await derivePasswordHash(password, salt);
        const account = {
            usernameKey: key,
            username: cleanUsername,
            role,
            salt: bytesToBase64(salt),
            passwordHash: bytesToBase64(passwordHash),
            iterations: ITERATIONS,
            createdAt: new Date().toISOString()
        };

        try {
            await accountRequest('readwrite', store => store.add(account));
        } catch (error) {
            if (error && error.name === 'ConstraintError') {
                throw new Error('Username sudah digunakan.');
            }
            throw error;
        }
        return account;
    }

    function bytesMatch(left, right) {
        if (left.length !== right.length) return false;
        let difference = 0;
        for (let index = 0; index < left.length; index++) {
            difference |= left[index] ^ right[index];
        }
        return difference === 0;
    }

    async function verifyPassword(account, password) {
        const hash = await derivePasswordHash(password, base64ToBytes(account.salt));
        return bytesMatch(hash, base64ToBytes(account.passwordHash));
    }

    async function changePassword(currentPassword, newPassword) {
        if (!activeAccount) throw new Error('Silakan masuk kembali untuk mengubah password.');
        if (newPassword.length < 8) throw new Error('Password baru harus minimal 8 karakter.');

        const key = usernameKey(activeAccount.username);
        const account = await accountRequest('readonly', store => store.get(key));
        if (!account || !(await verifyPassword(account, currentPassword))) {
            throw new Error('Password saat ini tidak sesuai.');
        }

        const salt = crypto.getRandomValues(new Uint8Array(16));
        const passwordHash = await derivePasswordHash(newPassword, salt);
        const updatedAccount = {
            ...account,
            salt: bytesToBase64(salt),
            passwordHash: bytesToBase64(passwordHash),
            iterations: ITERATIONS,
            passwordUpdatedAt: new Date().toISOString()
        };
        await accountRequest('readwrite', store => store.put(updatedAccount));
    }

    function renderAccounts(accounts) {
        const list = byId('auth-account-list');
        if (!list) return;
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
        renderAccounts(await listAccounts());
    }

    function showLogin() {
        activeAccount = null;
        sessionStorage.removeItem(SESSION_KEY);
        document.body.classList.remove('auth-ready');
        byId('auth-gate').hidden = false;
        byId('auth-setup-view').hidden = true;
        byId('auth-login-view').hidden = false;
        byId('user-management-modal').hidden = true;
        byId('change-password-modal').hidden = true;
        byId('auth-login-username').focus();
    }

    function loginAccount(account) {
        activeAccount = { username: account.username, role: account.role };
        sessionStorage.setItem(SESSION_KEY, account.usernameKey);
        byId('auth-session-label').textContent = `${activeAccount.username} ${activeAccount.role === 'admin' ? 'Admin' : 'User'}`;
        byId('auth-manage-users').hidden = activeAccount.role !== 'admin';
        byId('auth-gate').hidden = true;
        document.body.classList.add('auth-ready');
        resolveReady(activeAccount);
    }

    async function restoreSession() {
        const savedKey = sessionStorage.getItem(SESSION_KEY);
        if (!savedKey) return false;
        const account = await accountRequest('readonly', store => store.get(savedKey));
        if (!account) {
            sessionStorage.removeItem(SESSION_KEY);
            return false;
        }
        loginAccount(account);
        return true;
    }

    function showSetup() {
        byId('auth-subtitle').textContent = 'FAT East Region,dengan filter data Survey FAT';
        byId('auth-setup-view').hidden = false;
        byId('auth-login-view').hidden = true;
        byId('auth-setup-username').focus();
    }

    function bindEvents() {
        byId('auth-setup-form').addEventListener('submit', async event => {
            event.preventDefault();
            const button = event.currentTarget.querySelector('button[type="submit"]');
            button.disabled = true;
            setMessage('auth-setup-message', '');
            try {
                const account = await createAccount(
                    byId('auth-setup-username').value,
                    byId('auth-setup-password').value,
                    'admin'
                );
                loginAccount(account);
            } catch (error) {
                setMessage('auth-setup-message', error.message || 'Akun admin gagal dibuat.');
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
                const account = await accountRequest(
                    'readonly',
                    store => store.get(usernameKey(byId('auth-login-username').value))
                );
                if (!account || !(await verifyPassword(account, byId('auth-login-password').value))) {
                    setMessage('auth-login-message', 'Username atau password salah.');
                    return;
                }
                loginAccount(account);
            } catch (error) {
                setMessage('auth-login-message', error.message || 'Login gagal.');
            } finally {
                button.disabled = false;
            }
        });

        byId('auth-logout').addEventListener('click', showLogin);
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
                await changePassword(byId('auth-current-password').value, newPassword);
                form.reset();
                setMessage('change-password-message', 'Password berhasil diubah.');
            } catch (error) {
                setMessage('change-password-message', error.message || 'Password gagal diubah.');
            } finally {
                button.disabled = false;
            }
        });
        byId('auth-manage-users').addEventListener('click', async () => {
            if (activeAccount?.role !== 'admin') return;
            setMessage('admin-user-message', '');
            await refreshAccounts();
            byId('user-management-modal').hidden = false;
            byId('admin-new-username').focus();
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
            if (activeAccount?.role !== 'admin') {
                setMessage('admin-user-message', 'Hanya admin yang dapat menambahkan akun.');
                return;
            }
            const form = event.currentTarget;
            const button = byId('admin-user-submit');
            button.disabled = true;
            setMessage('admin-user-message', '');
            try {
                await createAccount(
                    byId('admin-new-username').value,
                    byId('admin-new-password').value,
                    byId('admin-new-role').value
                );
                form.reset();
                setMessage('admin-user-message', 'Akun berhasil ditambahkan.');
                await refreshAccounts();
            } catch (error) {
                setMessage('admin-user-message', error.message || 'Akun gagal ditambahkan.');
            } finally {
                button.disabled = false;
            }
        });
    }

    async function initialize() {
        try {
            database = await openDatabase();
            bindEvents();
            if (await restoreSession()) return;
            const accounts = await listAccounts();
            if (accounts.length === 0) showSetup();
            else byId('auth-login-view').hidden = false;
        } catch (error) {
            const message = error.message || 'Database akun gagal dimuat.';
            byId('auth-subtitle').textContent = message;
            setMessage('auth-login-message', message);
            byId('auth-login-view').hidden = false;
            console.error('[AUTH] Inisialisasi login gagal:', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
