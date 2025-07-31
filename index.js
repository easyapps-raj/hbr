import puppeteer from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

puppeteer.use(Stealth());
async function waitForSelectorWithRetry(page, selector, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.waitForSelector(selector, { timeout: 60000 });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Retrying ${selector} (${i + 1}/${retries})`);
      await page.reload({ waitUntil: "networkidle0" });
    }
  }
}

async function collectHbrLinks(page) {
  try {
    await page.goto("https://hbr.org/the-latest", {
      waitUntil: "networkidle2", // 1. Wait for the page to be fully loaded and idle
      timeout: 90000, // Keep a generous timeout for the initial load
    });

    // 2. Add a step to handle cookie consent banners
    try {
      const consentButtonSelector = "#truste-consent-button"; // Common selector for consent buttons
      await page.waitForSelector(consentButtonSelector, { timeout: 5000 }); // Wait briefly for the button
      console.log("Consent banner found, clicking accept...");
      await page.click(consentButtonSelector);
      await page.waitForNavigation({ waitUntil: "networkidle2" }); // Wait for any reload after clicking
    } catch (e) {
      console.log("No consent banner found, or it timed out. Continuing...");
    }

    const html = await page.content();
    console.log("Page content snippet:", html.slice(0, 1000));

    // Now, your existing logic should find the selector
    await waitForSelectorWithRetry(page, "h3.hed a");
  } catch (err) {
    console.error("Failed to load HBR:", err.message);
    return [];
  }

  // The rest of your function remains the same...
  while (true) {
    const btn = await page.$('li.load-more a[js-target="load-ten-more-link"]');
    if (!btn) break;
    await Promise.all([
      btn.click(),
      page.waitForResponse(
        (r) => r.url().includes("/latest") || r.url().includes("/load"),
        { timeout: 90000 }
      ),
      new Promise((res) => setTimeout(res, 800)),
    ]);
  }

  const links = await page.$$eval("h3.hed a", (as) =>
    as.map((a) => new URL(a.getAttribute("href"), "https://hbr.org").href)
  );
  return [...new Set(links)];
}

async function mineArchive(browser, originalUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
  );

  await page.goto("https://archive.is/", {
    waitUntil: "networkidle2",
    timeout: 90000,
  });

  const searchInput = 'form#search input[name="q"]';
  await page.waitForSelector(searchInput, { timeout: 45_000 });
  await page.type(searchInput, originalUrl);
  await Promise.all([
    page.keyboard.press("Enter"),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 }),
  ]);

  let resultsRoot = page;
  const frameHandle = await page.$('frame[name="frame"]');
  if (frameHandle) {
    resultsRoot = await frameHandle.contentFrame();
  }

  const snapLinkSel = 'div.TEXT-BLOCK a[href^="https://archive.is/"]';
  try {
    await resultsRoot.waitForSelector(snapLinkSel, { timeout: 15_000 });
  } catch {
    console.warn("no snapshot for", originalUrl);
    await page.close();
    return { title: "NO SNAPSHOT", body: "", snapshotUrl: "none" };
  }
  const snapshotHref = await resultsRoot.$eval(snapLinkSel, (a) => a.href);

  await Promise.all([
    resultsRoot.$eval(snapLinkSel, (a) => a.click()),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 0 }),
  ]);

  const { title, body } = await page.evaluate(() => {
    const title =
      document.querySelector("#CONTENT h1")?.innerText.trim() ||
      document.querySelector("h1")?.innerText.trim() ||
      document.title.replace(/ \|.*$/, "").trim();

    const unwanted = [
      "Subscribe",
      "Sign In",
      "Read more",
      "Post",
      "Share",
      "Save",
      "Print",
      "{{terminalError}}",
      "Recaptcha requires verification",
      "Privacy - Terms",
      /\d{1,3}%\s*$/,
    ];
    const bad = (t) =>
      !t ||
      unwanted.some((p) => (typeof p === "string" ? t.includes(p) : p.test(t)));

    const blocks = Array.from(
      document.querySelectorAll("#CONTENT p, #CONTENT div, article p")
    )
      .map((el) => el.innerText.trim())
      .filter((t) => !bad(t));

    const firstReal = blocks.findIndex((t) => t.length > 40);
    const clean = firstReal === -1 ? blocks : blocks.slice(firstReal);

    return { title, body: clean.join("\n\n") };
  });

  const snapshotUrl = page.url();
  await page.close();
  return { title, body, snapshotUrl };
}

async function cleanBodyWithGroq(title, body) {
  try {
    const prompt = `
    Clean the following article content:
    - Remove ads, social media mentions, "share", "subscribe", "sign in","sign up", or any unrelated text.
    - Preserve the article's main content only.
    - Also dont write Here is the cleaned-up article content:
    - Try give full article and dont cut in between
    - Dont mention that this is a cleaned-up article
    - Also dont mention any unwanted spaces or new lines
    - dont mention any unwanted information
    
    Title: ${title}
    Body:
    ${body}
    `;

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-70b-8192",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("GROQ cleanup failed:", err.message);
    return body;
  }
}
const endpoint = process.env.WP_URL;

async function sendToWordPress(title, body) {
  try {
    const response = await axios.post(endpoint, {
      title: title,
      body: body,
    });
    console.log("✓ Posted to WordPress:", response.data);
  } catch (err) {
    console.error(
      "✗ Error posting to WordPress:",
      err.response?.data || err.message
    );
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1920,1080",
    ],
    defaultViewport: null,
  }); //

  const surf = await browser.newPage();
  await surf.setRequestInterception(true);
  surf.on("request", (req) => {
    const resourceType = req.resourceType();
    const url = req.url();

    if (
      resourceType === "image" ||
      resourceType === "stylesheet" ||
      resourceType === "font" ||
      url.includes("google-analytics") ||
      url.includes("googletagmanager") ||
      url.includes("facebook")
    ) {
      req.abort();
    } else {
      req.continue();
    }
  });
  await surf.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
  );

  console.log("Collecting article links from HBR…");
  const links = await collectHbrLinks(surf);
  console.log(`✓ Found ${links.length} links`);

  const rows = [];
  for (const [i, link] of links.entries()) {
    try {
      console.log(`[${i + 1}/${links.length}] Archiving ${link}`);
      const { title, body, snapshotUrl } = await mineArchive(browser, link);
      const cleanedBody = await cleanBodyWithGroq(title, body);
      sendToWordPress(title, cleanedBody);
      console.log(`${title}:${cleanedBody}`);
      rows.push([title, cleanedBody]);
    } catch (err) {
      console.error(`✗ ${link}: ${err.message}`);
    }
    await new Promise((res) => setTimeout(res, 1500));
  }

  console.log("Writing to Google Sheet…");
  console.log(rows);
  // if (rows.length) await appendRows(rows);
  await browser.close();
  console.log("Done!");
})();
