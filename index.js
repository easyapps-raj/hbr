import puppeteer from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

puppeteer.use(Stealth());

async function collectHbrLinks(page) {
  try {
    await page.goto("https://hbr.org/the-latest", {
      waitUntil: "load",
      timeout: 80000,
    });

    await page.waitForSelector("h3.hed a", { timeout: 80000 });
  } catch (err) {
    console.error("Failed to load HBR:", err.message);
    return [];
  }

  while (true) {
    const btn = await page.$('li.load-more a[js-target="load-ten-more-link"]');
    if (!btn) break;
    await Promise.all([
      btn.click(),
      page.waitForResponse(
        (r) => r.url().includes("/latest") || r.url().includes("/load")
      ),
      await new Promise((res) => setTimeout(res, 800)),
    ]);
  }

  const links = await page.$$eval("h3.hed a", (as) =>
    as.map((a) => new URL(a.getAttribute("href"), "https://hbr.org").href)
  );
  return [...new Set(links)];
}

async function mineArchive(browser, originalUrl) {
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.goto("https://archive.is/", {
    waitUntil: "domcontentloaded",
    timeout: 0,
  });

  const searchInput = 'form#search input[name="q"]';
  await page.waitForSelector(searchInput, { timeout: 45_000 });
  await page.type(searchInput, originalUrl);
  await Promise.all([
    page.keyboard.press("Enter"),
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
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
  await surf.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
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
  if (rows.length) await appendRows(rows);
  await browser.close();
  console.log("Done!");
})();
