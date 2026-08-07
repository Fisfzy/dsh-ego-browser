function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function searchAndExtract(ctx, args = {}) {
  const query = args.query || "";
  const maxResults = boundedInteger(args.maxResults, 10, 100);
  if (!query) throw new Error("search query is required");

  await ctx.browser.openOrReuseTab(
    `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  const results = await ctx.page
    .locator("div.g")
    .evaluateAll((items, limit) => {
      return items
        .slice(0, limit)
        .map((el) => ({
          title: el.querySelector("h3")?.innerText?.trim() || "",
          url: el.querySelector("a")?.getAttribute("href") || "",
          snippet:
            el.querySelector("[data-sncf]")?.innerText?.trim() ||
            el.querySelector("span")?.innerText?.trim() ||
            "",
        }))
        .filter((r) => r.title);
    }, maxResults);

  return results;
}
