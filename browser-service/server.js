/**
 * Browser Service
 * ----------------
 * HTTP service nội bộ (KHÔNG public ra ngoài internet) để n8n gọi vào,
 * dùng Playwright (Chromium) + stealth plugin để render trang có JS-challenge
 * (ví dụ DataDome/Cloudflare) và trả về HTML đã render.
 *
 * QUAN TRỌNG:
 * - Đây không phải giải pháp "chắc chắn vượt được" mọi anti-bot. WSJ dùng
 *   DataDome, có thể vẫn chặn nếu pattern truy cập bất thường (IP datacenter,
 *   request quá đều đặn theo cron, không có cookie session hợp lệ...).
 * - Chỉ nên dùng cho mục đích cá nhân/nội bộ, tần suất thấp, tôn trọng
 *   Terms of Service của trang đích.
 */

const express = require("express");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
// Token đơn giản để n8n xác thực khi gọi vào service này (đặt qua biến môi trường)
const AUTH_TOKEN = process.env.BROWSER_SERVICE_TOKEN || "change-me";
// Cookie JSON từ Render / môi trường để dùng cho WSJ hoặc trang cần session
const WSJ_COOKIES_JSON = process.env.WSJ_COOKIES_JSON || "";

const SAMESITE_MAP = {
  no_restriction: "None",
  lax: "Lax",
  strict: "Strict",
  none: "None",
};

function normalizeSameSite(value) {
  if (!value) return "Lax";
  const normalized = SAMESITE_MAP[value.toLowerCase()];
  return normalized || "Lax";
}

function normalizeCookies(cookies) {
  return cookies.map((c) => {
    const valid = ["Strict", "Lax", "None"];
    const sameSite = valid.includes(c.sameSite)
      ? c.sameSite
      : normalizeSameSite(c.sameSite);
    return { ...c, sameSite };
  });
}

function parseCookiesJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    let cookies;
    if (Array.isArray(parsed)) cookies = parsed;
    else if (parsed && typeof parsed === "object") cookies = [parsed];
    else {
      console.warn("WSJ_COOKIES_JSON phải là JSON array hoặc object cookie");
      return [];
    }
    return normalizeCookies(cookies);
  } catch (err) {
    console.warn("Không parse được WSJ_COOKIES_JSON:", err.message);
  }
  return [];
}

const wsjCookies = parseCookiesJson(WSJ_COOKIES_JSON);

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return browserInstance;
}

// Health check KHÔNG yêu cầu token — để Render (hoặc bất kỳ platform PaaS
// nào dùng healthCheckPath) gọi được mà không bị chặn 401.
app.get("/health", (req, res) => res.json({ ok: true }));

// Middleware xác thực đơn giản — áp dụng cho mọi route PHÍA SAU dòng này
app.use((req, res, next) => {
  const token = req.header("x-auth-token");
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing x-auth-token" });
  }
  next();
});

/**
 * POST /fetch-html
 * Body: { "url": "https://...", "waitForSelector": "optional-css-selector", "timeoutMs": 30000 }
 * Trả về: { "html": "...", "status": 200, "finalUrl": "..." }
 */
app.post("/fetch-html", async (req, res) => {
  const { url, waitForSelector, timeoutMs = 30000 } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing 'url' in request body" });
  }

  let context;
  try {
    const browser = await getBrowser();

    // Attempt 1: Với WSJ_COOKIES_JSON (nếu có)
    console.log(`[Attempt 1] Fetching: ${url}`);
    const html1 = await fetchPageWithContext(browser, url, wsjCookies, waitForSelector, timeoutMs);
    
    if (html1.status === 401 && html1.html.includes("datadome")) {
      console.log(`[Attempt 1] Got DataDome challenge (401). Extracting datadome cookie...`);
      
      // Parse datadome cookie từ HTML response
      const datadomeMatch = html1.html.match(/'cookie':'([^']+)'/);
      if (datadomeMatch && datadomeMatch[1]) {
        const datadomeValue = datadomeMatch[1];
        console.log(`[Attempt 2] Retrying with datadome cookie: ${datadomeValue.substring(0, 30)}...`);
        
        // Attempt 2: Với datadome cookie mới
        const datadomeOnlyCookie = [{
          name: "datadome",
          value: datadomeValue,
          domain: ".wsj.com",
          path: "/",
          httpOnly: false,
          secure: false,
          sameSite: "Lax"
        }];
        
        // Combine WSJ cookies + datadome
        const combinedCookies = [...wsjCookies, ...datadomeOnlyCookie];
        const html2 = await fetchPageWithContext(browser, url, combinedCookies, waitForSelector, timeoutMs);
        
        if (html2.status !== 401 || !html2.html.includes("datadome")) {
          return res.json(html2);
        }
      }
    }
    
    return res.json(html1);
  } catch (err) {
    console.error("fetch-html error:", err.message || err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
});

async function fetchPageWithContext(browser, url, cookies, waitForSelector, timeoutMs) {
  let context;
  try {
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.wsj.com/",
        "DNT": "1",
      },
    });

    const page = await context.newPage();

    if (cookies && cookies.length > 0) {
      try {
        await context.addCookies(normalizeCookies(cookies));
        console.log(`Added ${cookies.length} cookies`);
      } catch (err) {
        console.warn("Không thêm được cookies vào context:", err.message);
      }
    }

    // Thêm delay nhỏ trước navigate để giả lập user thực
    await page.waitForTimeout(500);

    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const status = response ? response.status() : null;
    console.log(`Response status: ${status}`);

    // Chờ thêm vì DataDome iframe có thể cần thời gian để load
    await page.waitForTimeout(1000);

    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: Math.min(5000, timeoutMs) });
      } catch (e) {
        console.warn(`waitForSelector timeout: ${waitForSelector}`);
      }
    }

    const html = await page.content();
    const finalUrl = page.url();
    const contextCookies = await context.cookies();

    await context.close();

    return { html, status, finalUrl, cookies: contextCookies, debug: { statusCode: status } };
  } catch (err) {
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
    throw err;
  }
}

app.listen(PORT, () => {
  console.log(`Browser service listening on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
