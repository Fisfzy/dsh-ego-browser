function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

export async function getTimelinePosts(ctx, args = {}) {
  const maxPosts = boundedInteger(args.maxPosts, 50, 100);

  const posts = await ctx.page
    .locator('[data-testid="tweet"]')
    .evaluateAll((articles, limit) => {
      return articles.slice(0, limit).map((el) => ({
        text:
          el.querySelector('[data-testid="tweetText"]')?.innerText?.trim() ||
          "",
        author:
          el
            .querySelector('[data-testid="User-Name"]')
            ?.querySelector("span")
            ?.innerText?.trim() || "",
        handle:
          el
            .querySelector('[data-testid="User-Name"]')
            ?.querySelector("a")
            ?.getAttribute("href") || "",
        timestamp: el.querySelector("time")?.getAttribute("datetime") || "",
      }));
    }, maxPosts);

  return posts;
}
