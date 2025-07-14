import puppeteer from "puppeteer-extra";
import Stealth from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";
dotenv.config();

puppeteer.use(Stealth());

/* ---------- Step 1: grab HBR article URLs ---------- */
async function collectHbrLinks(page) {
  await page.goto("https://hbr.org/the-latest", {
    waitUntil: "domcontentloaded",
  });

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

/* ---------- iframe‑aware mineArchive using nNiSn loader ---------- */
async function mineArchive(browser, originalUrl) {
  const loader = "https://archive.is/nNiSn";
  const page = await browser.newPage();

  /* 1️⃣ open loader and submit URL */
  await page.goto(loader, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const inputSel = 'input[name="q"]';
  await page.focus(inputSel);
  await page.evaluate(
    (sel) => (document.querySelector(sel).value = ""),
    inputSel
  );
  await page.type(inputSel, originalUrl);
  await Promise.all([
    page.keyboard.press("Enter"),
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
  ]);

  /* 2️⃣ check every 0.5 s for either:
        a) a frame with snapshot
        b) <h1> already in root document                                 */
  const maxT = Date.now() + 60_000;
  let contentFrame = null;
  while (Date.now() < maxT) {
    // a) look for a frame whose URL contains /archive.is/<digits>/
    contentFrame =
      page
        .frames()
        .find((f) => /https:\/\/archive\.is\/\d{14}\//.test(f.url())) ?? null;

    // b) if root already has <h1>, use the root
    const rootHasH1 = await page.$("h1");
    if (contentFrame || rootHasH1) break;

    await new Promise((r) => setTimeout(r, 500));
  }

  if (!contentFrame && !(await page.$("h1"))) {
    console.warn("❌ no snapshot for:", originalUrl);
    await page.close();
    return { title: "NO SNAPSHOT", body: "", snapshotUrl: "none" };
  }

  /* 3️⃣ pick the right context (frame or root) */
  const ctx = contentFrame || page;

  /* 4️⃣ wait for article text inside that context */
  await ctx.waitForSelector("h1, article p, #CONTENT p", { timeout: 60_000 });

  /* 5️⃣ extract */
  const { title, body } = await ctx.evaluate(() => {
    const title =
      document.querySelector("#CONTENT h1")?.innerText.trim() ||
      document.title.replace(/ \|.*$/, "").trim();

    const unwantedPhrases = [
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
      /\d{1,3}%\s*$/, // percentage indicators like 10%, 20%, etc.
    ];

    const isUnwanted = (text) => {
      const trimmed = text.trim();
      return (
        !trimmed ||
        unwantedPhrases.some((phrase) =>
          typeof phrase === "string"
            ? trimmed.includes(phrase)
            : phrase.test(trimmed)
        )
      );
    };

    const textBlocks = Array.from(
      document.querySelectorAll("#CONTENT p, #CONTENT div")
    )
      .map((el) => el.innerText.trim())
      .filter((text) => !isUnwanted(text));

    return { title, body: textBlocks.join("\n\n") };
  });

  const snapshotUrl = (contentFrame || page).url();
  await page.close();
  return { title, body, snapshotUrl };
}

/* ---------- Orchestrator ---------- */
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"],
    defaultViewport: null,
  }); //

  const surf = await browser.newPage();
  console.log("Collecting article links from HBR…");
  const links = await collectHbrLinks(surf);
  console.log(`✓ Found ${links.length} links`);

  const rows = [];
  for (const [i, link] of links.entries()) {
    try {
      console.log(`[${i + 1}/${links.length}] Archiving ${link}`);
      const { title, body, snapshotUrl } = await mineArchive(browser, link);
      console.log(`✓ ${title}: (${body})`);
      rows.push([title, body]);
    } catch (err) {
      console.error(`✗ ${link}: ${err.message}`);
    }
    // throttle so archive.today doesn't block us
    await new Promise((res) => setTimeout(res, 1500));
  }

  console.log("Writing to Google Sheet…");
  console.log(rows);
  if (rows.length) await appendRows(rows);
  await browser.close();
  console.log("✅ Done!");
})();
