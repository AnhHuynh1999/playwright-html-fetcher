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

function parseCookiesJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
    console.warn("WSJ_COOKIES_JSON phải là JSON array hoặc object cookie");
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

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
    });

    const page = await context.newPage();

    if (wsjCookies.length > 0) {
      try {
        await context.addCookies(wsjCookies);
      } catch (err) {
        console.warn("Không thêm được WSJ_COOKIES_JSON vào context:", err.message);
      }
    }

    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: timeoutMs,
    });

    if (waitForSelector) {
      try {
        await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
      } catch (e) {
        // Không tìm thấy selector — vẫn tiếp tục trả về HTML hiện có để debug
        console.warn(`waitForSelector timeout: ${waitForSelector}`);
      }
    }

    const html = await page.content();
    const status = response ? response.status() : null;
    const finalUrl = page.url();
    const cookies = await context.cookies();

    await context.close();

    return res.json({ html, status, finalUrl, cookies });
  } catch (err) {
    if (context) {
      try {
        await context.close();
      } catch (_) {}
    }
    console.error("fetch-html error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Browser service listening on port ${PORT}`);
});

process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
