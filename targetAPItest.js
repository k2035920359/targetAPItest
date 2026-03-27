const http = require("http");
const https = require("https");
const { URL } = require("url"); 
const fs = require("fs");
const path = require("path");

const configPath = path.join(process.cwd(), "config.json");
let CONFIG = {};


try {
    if (fs.existsSync(configPath)) {
        const configFile = fs.readFileSync(configPath, 'utf8');
        CONFIG = JSON.parse(configFile);
        console.log(`[Info] 成功載入外部設定檔: ${configPath}`);
        console.table(CONFIG);
    } else {
        console.error(`[Error] 找不到設定檔！`);
        process.exit(1);
    }
} catch (err) {
    console.error(`[Error] 讀取或解析 config.json 失敗:`, err.message);
    process.exit(1);
}


const requiredKeys = ['loginUrl', 'loginMethod', 'loginPayload', 'tokenFieldPath', 'targetUrl', 'targetMethod', 'intervalMs', 'timeoutMs'];
for (const key of requiredKeys) {
    if (CONFIG[key] === undefined) {
        console.error(`[Error] config.json 缺少必要參數: ${key}`);
        process.exit(1);
    }
}

let authToken = null;
let sessionCookie = null;


function now() {
    return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

function log(message) {
    const line = `${now()} ${message}`;
    console.log(line);
    if (CONFIG.logFile) {
        fs.appendFileSync(CONFIG.logFile, line + "\n");
    }
}

function classifyError(err) {
    const msg = (err && err.message ? err.message : "").toLowerCase();
    const code = err && err.code ? err.code : "";
    if (code === "ECONNRESET") return "ERROR: Connection reset";
    if (code === "ETIMEDOUT" || msg.includes("timeout")) return "ERROR: Timeout";
    if (code === "ECONNREFUSED") return "ERROR: Connection refused";
    return `ERROR: ${code || "UNKNOWN"} ${err.message || ""}`.trim();
}

function getNestedValue(obj, pathArray) {
    return pathArray.reduce((acc, key) => (acc && acc[key] !== undefined) ? acc[key] : undefined, obj);
}

function extractCookie(setCookieHeaders) {
    if (!setCookieHeaders || !Array.isArray(setCookieHeaders)) return null;
    return setCookieHeaders.map(s => s.split(";")[0]).join("; ");
}


function doRequest({ url, method, payload, extraHeaders = {} }) {
    return new Promise((resolve, reject) => {
        
        const urlObj = new URL(url); 
        const client = urlObj.protocol === "https:" ? https : http;
        
        const body = JSON.stringify(payload || {});
        const headers = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...extraHeaders,
        };

        
        const options = {
            protocol: urlObj.protocol,
            hostname: urlObj.hostname,
            port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: headers
        };

        const req = client.request(options, (res) => {
            let responseData = "";
            res.on("data", (chunk) => responseData += chunk);
            res.on("end", () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: responseData,
                });
            });
        });

        req.setTimeout(CONFIG.timeoutMs, () => {
            req.destroy(new Error("Request timeout"));
        });

        req.on("error", (err) => reject(err));
        req.write(body);
        req.end();
    });
}

// 4. 登入
async function login() {
    try {
        log("INFO: Login start");
        const res = await doRequest({
            url: CONFIG.loginUrl,
            method: CONFIG.loginMethod,
            payload: CONFIG.loginPayload,
        });

        log(`INFO: Login HTTP ${res.statusCode}`);
        if (res.statusCode < 200 || res.statusCode >= 300) return false;

        if (CONFIG.useCookieAuth) {
            sessionCookie = extractCookie(res.headers["set-cookie"]);
            return !!sessionCookie;
        }

        const parsed = JSON.parse(res.body || "{}");
        authToken = getNestedValue(parsed, CONFIG.tokenFieldPath);
        return !!authToken;
    } catch (err) {
        log(classifyError(err));
        return false;
    }
}

function buildAuthHeaders() {
    const h = {};
    if (sessionCookie) h["Cookie"] = sessionCookie;
    if (authToken) h["Authorization"] = `Bearer ${authToken}`;
    return h;
}

async function callTargetApi() {
    try {
        const res = await doRequest({
            url: CONFIG.targetUrl,
            method: CONFIG.targetMethod,
            payload: CONFIG.targetPayload,
            extraHeaders: buildAuthHeaders(),
        });

        if (res.statusCode === 401 && CONFIG.reloginOn401) {
            log("WARN: 401 Unauthorized, retrying login...");
            if (await login()) {
                return await callTargetApi(); // 遞迴重試一次
            }
        }
        log(`SUCCESS: [${CONFIG.targetMethod}] ${res.statusCode}`);
    } catch (err) {
        log(classifyError(err));
    }
}

async function start() {
    log("=== Test Started ===");
    await login();
    await callTargetApi();
    setInterval(callTargetApi, CONFIG.intervalMs);
}

process.on("SIGINT", () => {
    log("Test stopped by user");
    process.exit(0);
});

start();