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

/* ---------- mineArchive: search → pick first snapshot → scrape ---------- */
async function mineArchive(browser, originalUrl) {
  /* use normal desktop UA so archive.today doesn’t hide the form */
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  /* 1️⃣ open archive.today home */
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.goto("https://archive.is/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  /* 2️⃣ fill the SEARCH form (not the save‑url form) */
  const searchInput = 'form#search input[name="q"]';
  await page.type(searchInput, originalUrl);
  await Promise.all([
    page.keyboard.press("Enter"),
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
  ]);

  /* 3️⃣ results table lives inside <frame name="frame"> */
  let resultsRoot = page; // default
  const frameHandle = await page.$('frame[name="frame"]');
  if (frameHandle) {
    resultsRoot = await frameHandle.contentFrame();
  }

  /* pick the first snapshot link */
  const snapLinkSel = 'div.TEXT-BLOCK a[href^="https://archive.is/"]';
  try {
    await resultsRoot.waitForSelector(snapLinkSel, { timeout: 15_000 });
  } catch {
    console.warn("❌ no snapshot for", originalUrl);
    await page.close();
    return { title: "NO SNAPSHOT", body: "", snapshotUrl: "none" };
  }
  const snapshotHref = await resultsRoot.$eval(snapLinkSel, (a) => a.href);

  /* 4️⃣ open the snapshot */
  await page.goto(snapshotHref, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  /* 5️⃣ scrape title + body and filter noise */
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
      /\d{1,3}%\s*$/, // 0%, 10%, …
    ];
    const bad = (t) =>
      !t ||
      unwanted.some((p) => (typeof p === "string" ? t.includes(p) : p.test(t)));

    const blocks = Array.from(
      document.querySelectorAll("#CONTENT p, #CONTENT div, article p")
    )
      .map((el) => el.innerText.trim())
      .filter((t) => !bad(t));

    /* drop short header crumbs (category lines, etc.) */
    const firstReal = blocks.findIndex((t) => t.length > 40);
    const clean = firstReal === -1 ? blocks : blocks.slice(firstReal);

    return { title, body: clean.join("\n\n") };
  });

  const snapshotUrl = page.url();
  await page.close();
  return { title, body, snapshotUrl };
}

/* ---------- Orchestrator ---------- */
(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox"],
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
      console.log(`${title}:${body}`);
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
