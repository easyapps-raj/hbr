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

async function retry(fn, attempts = 3, delay = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      console.warn(`Retry ${i + 1}/${attempts} failed: ${e.message}`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("All retries failed.");
}

async function collectHbrLinks(page) {
  try {
    await page.goto("https://hbr.org/the-latest", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    try {
      const consentButtonSelector = "#truste-consent-button";
      await page.waitForSelector(consentButtonSelector, { timeout: 5000 });
      console.log("Consent banner found, clicking accept...");
      await page.click(consentButtonSelector);
      await page.waitForNavigation({ waitUntil: "networkidle2" });
    } catch (e) {
      console.log("No consent banner found, or it timed out. Continuing...");
    }

    await page.waitForSelector("h3.hed a", { timeout: 60000 });

    while (true) {
      const btn = await page.$(
        'li.load-more a[js-target="load-ten-more-link"]'
      );
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
  } catch (err) {
    console.error("Failed to load HBR:", err.message);
    return [];
  }
}

async function mineArchive(browser, originalUrl) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
  );

  try {
    await page.goto(
      `https://archive.is/?run=1&url=${encodeURIComponent(originalUrl)}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      }
    );

    await page.waitForTimeout(5000); // wait for background processing

    const frameHandle = await page
      .waitForSelector('frame[name="frame"]', { timeout: 15000 })
      .catch(() => null);
    let resultsRoot = page;

    if (frameHandle) {
      const frame = await frameHandle.contentFrame();
      if (frame) resultsRoot = frame;
    }

    const snapLinkSel = 'div.TEXT-BLOCK a[href^="https://archive.is/"]';
    await resultsRoot.waitForSelector(snapLinkSel, { timeout: 30000 });
    const snapshotHref = await resultsRoot.$eval(snapLinkSel, (a) => a.href);

    // Extra retry if snapshot load is incomplete
    await page.goto(snapshotHref, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    // Ensure snapshot content is loaded
    await page.waitForSelector("h1, #CONTENT", { timeout: 15000 });

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
        unwanted.some((p) =>
          typeof p === "string" ? t.includes(p) : p.test(t)
        );

      const blocks = Array.from(
        document.querySelectorAll("#CONTENT p, #CONTENT div, article p")
      )
        .map((el) => el.innerText.trim())
        .filter((t) => !bad(t));

      const firstReal = blocks.findIndex((t) => t.length > 40);
      const clean = firstReal === -1 ? blocks : blocks.slice(firstReal);

      return { title, body: clean.join("\n\n") };
    });

    await page.close();
    return { title, body };
  } catch (e) {
    console.warn("Failed archiving:", originalUrl, e.message);
    await page.close();
    return { title: "NO SNAPSHOT", body: "" };
  }
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
    console.log("Posted to WordPress:", response.data);
  } catch (err) {
    console.error(
      "Error posting to WordPress:",
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
    ],
  });

  const surf = await browser.newPage();
  await surf.setRequestInterception(true);
  surf.on("request", (req) => {
    if (["image", "stylesheet", "font"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  console.log("Collecting article links from HBR…");
  const links = await collectHbrLinks(surf);
  console.log(`✓ Found ${links.length} links`);

  const rows = [];
  for (const [i, link] of links.entries()) {
    try {
      console.log(`[${i + 1}/${links.length}] Attempting to archive: ${link}`);

      // Use the archive function, wrapped in our retry logic.
      const { title, body } = await retry(() => mineArchive(browser, link));

      // This check is critical to prevent posting bad data.
      if (
        !title ||
        !body ||
        title === "ARCHIVE FAILED" ||
        title === "NO SNAPSHOT"
      ) {
        console.warn(
          `Skipping ${link} due to archive failure or missing content.`
        );
        continue;
      }

      const cleanedBody = await cleanBodyWithGroq(title, body);
      await sendToWordPress(title, cleanedBody);
      console.log(`✓ Posted: ${title}`);
      rows.push([title, cleanedBody]);
    } catch (err) {
      console.error(
        `✗ An unexpected error occurred for ${link}: ${err.message}`
      );
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  console.log("Writing to Google Sheet…");
  console.log(rows);
  await browser.close();
  console.log("Done!");
})();
